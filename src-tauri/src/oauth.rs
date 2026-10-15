//! One-shot loopback listener for the OAuth 2.0 authorization code flow (RFC 8252): the browser
//! is sent back to http://127.0.0.1:<port>/..., and Forge reads the code from that request.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
pub struct OAuthListeners(Mutex<HashMap<String, TcpListener>>);

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>Forge</title><body style=\"font:16px system-ui;padding:48px;color:#18251d;background:#f8f9f5\"><h2 style=\"font-weight:500\">Signed in</h2><p>You can close this tab and go back to Forge.</p>";

/// Binds 127.0.0.1 on the given port (0 picks a free one) and returns the port in use.
#[tauri::command]
pub async fn oauth_listen(id: String, port: u16, state: tauri::State<'_, OAuthListeners>) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Couldn't listen on 127.0.0.1:{port} for the sign-in redirect: {e}"))?;
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
    state.0.lock().unwrap().insert(id, listener);
    Ok(bound)
}

/// Waits for the browser's redirect and returns its query string. Ignores other requests
/// (such as /favicon.ico) and gives up after `timeout_ms`.
#[tauri::command]
pub async fn oauth_wait(id: String, timeout_ms: u64, state: tauri::State<'_, OAuthListeners>) -> Result<String, String> {
    let listener = state.0.lock().unwrap().remove(&id).ok_or("No sign-in is waiting")?;
    tokio::time::timeout(Duration::from_millis(timeout_ms), accept_redirect(listener))
        .await
        .map_err(|_| "Sign-in timed out. Try again.".to_string())?
}

/// Stops waiting, for example when the user cancels.
#[tauri::command]
pub fn oauth_cancel(id: String, state: tauri::State<'_, OAuthListeners>) {
    state.0.lock().unwrap().remove(&id);
}

pub async fn accept_redirect(listener: TcpListener) -> Result<String, String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
        let head = String::from_utf8_lossy(&buf[..n]);
        let target = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
        let query = target.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
        let is_redirect = query.contains("code=") || query.contains("error=");
        let (status, body) = if is_redirect { ("200 OK", PAGE) } else { ("404 Not Found", "") };
        let res = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = sock.write_all(res.as_bytes()).await;
        if is_redirect {
            return Ok(query);
        }
    }
}
