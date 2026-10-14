//! WebSocket client connections, surfaced to the UI as `ws-event`s.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::http::Kv;

enum Cmd {
    Send(String),
    Close,
}

#[derive(Default)]
pub struct WsManager(Mutex<HashMap<String, mpsc::UnboundedSender<Cmd>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsEvent {
    conn_id: String,
    kind: &'static str, // open | in | out | close | error
    data: String,
    ts: u128,
}

fn emit(app: &AppHandle, conn_id: &str, kind: &'static str, data: String) {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let _ = app.emit("ws-event", WsEvent { conn_id: conn_id.to_string(), kind, data, ts });
}

#[tauri::command]
pub async fn ws_connect(
    app: AppHandle,
    id: String,
    url: String,
    headers: Vec<Kv>,
    manager: tauri::State<'_, WsManager>,
) -> Result<(), String> {
    let mut req = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    for h in headers.iter().filter(|h| h.enabled && !h.key.is_empty()) {
        let name: tokio_tungstenite::tungstenite::http::HeaderName =
            h.key.parse().map_err(|_| format!("Bad header name {}", h.key))?;
        let value = HeaderValue::from_str(&h.value).map_err(|e| e.to_string())?;
        req.headers_mut().insert(name, value);
    }
    let (stream, res) = tokio_tungstenite::connect_async(req).await.map_err(|e| e.to_string())?;
    emit(&app, &id, "open", format!("Connected ({})", res.status()));
    let (tx, mut rx) = mpsc::unbounded_channel();
    if let Some(old) = manager.0.lock().unwrap().insert(id.clone(), tx) {
        let _ = old.send(Cmd::Close);
    }
    let (mut sink, mut source) = stream.split();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(Cmd::Send(text)) => {
                        if let Err(e) = sink.send(Message::text(text.clone())).await {
                            emit(&app, &id, "error", e.to_string());
                            break;
                        }
                        emit(&app, &id, "out", text);
                    }
                    Some(Cmd::Close) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        emit(&app, &id, "close", "Closed by client".into());
                        break;
                    }
                },
                msg = source.next() => match msg {
                    Some(Ok(Message::Text(t))) => emit(&app, &id, "in", t.to_string()),
                    Some(Ok(Message::Binary(b))) => emit(&app, &id, "in", format!("<binary {} bytes>", b.len())),
                    Some(Ok(Message::Close(frame))) => {
                        emit(&app, &id, "close", frame.map(|f| format!("{} {}", f.code, f.reason)).unwrap_or_default());
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => { emit(&app, &id, "error", e.to_string()); break; }
                    None => { emit(&app, &id, "close", "Stream ended".into()); break; }
                },
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn ws_send(id: String, text: String, manager: tauri::State<'_, WsManager>) -> Result<(), String> {
    let map = manager.0.lock().unwrap();
    let tx = map.get(&id).ok_or("Not connected")?;
    tx.send(Cmd::Send(text)).map_err(|_| "Connection closed".to_string())
}

#[tauri::command]
pub fn ws_close(id: String, manager: tauri::State<'_, WsManager>) {
    if let Some(tx) = manager.0.lock().unwrap().remove(&id) {
        let _ = tx.send(Cmd::Close);
    }
}
