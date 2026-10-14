//! MCP client: JSON-RPC over stdio, Streamable HTTP, or legacy HTTP+SSE.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Notify};
use tokio::task::AbortHandle;

use crate::http::Kv;
use crate::sse::SseParser;

pub const PROTOCOL_VERSION: &str = "2025-06-18";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Deserialize)]
#[serde(tag = "transport", rename_all = "lowercase")]
pub enum McpConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: Vec<Kv>,
        cwd: Option<String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: Vec<Kv>,
    },
    Sse {
        url: String,
        #[serde(default)]
        headers: Vec<Kv>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub session_id: String,
    pub dir: &'static str, // "out" | "in" | "stderr" | "info"
    pub message: Value,
    pub ts: u128,
}

/// Where traffic logs go: the UI in the app, a channel in tests.
pub type Sink = Arc<dyn Fn(LogEvent) + Send + Sync>;

enum Transport {
    Stdio { stdin: tokio::sync::Mutex<ChildStdin>, child: tokio::sync::Mutex<Child> },
    Http { client: reqwest::Client, url: String, headers: Vec<Kv>, session: Mutex<Option<String>> },
    Sse { client: reqwest::Client, headers: Vec<Kv>, endpoint: Mutex<Option<String>>, ready: Notify },
}

pub struct Session {
    id: String,
    sink: Sink,
    transport: Transport,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    protocol: Mutex<String>,
    tasks: Mutex<Vec<AbortHandle>>,
    init_result: Mutex<Value>,
}

#[derive(Default)]
pub struct McpManager(Mutex<HashMap<String, Arc<Session>>>);

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// GUI apps on macOS get a bare PATH; borrow the login shell's so `npx`, `uvx`, etc. resolve.
fn shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let fallback = std::env::var("PATH").unwrap_or_default();
        if cfg!(windows) {
            return fallback;
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        std::process::Command::new(shell)
            .args(["-ilc", "printf '%s' \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|p| p.lines().last().unwrap_or("").to_string())
            .filter(|p| !p.is_empty())
            .unwrap_or(fallback)
    })
}

impl Session {
    fn log(&self, dir: &'static str, message: Value) {
        (self.sink)(LogEvent { session_id: self.id.clone(), dir, message, ts: now_ms() });
    }

    fn track(&self, h: AbortHandle) {
        self.tasks.lock().unwrap().push(h);
    }

    /// Routes a message received from the server.
    fn incoming(self: &Arc<Self>, msg: Value) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(self.incoming_inner(msg))
    }

    async fn incoming_inner(self: &Arc<Self>, msg: Value) {
        if let Value::Array(batch) = msg {
            for m in batch {
                self.incoming(m).await;
            }
            return;
        }
        self.log("in", msg.clone());
        let id = msg.get("id").cloned();
        match (msg.get("method").and_then(Value::as_str), id) {
            // Server -> client request: answer what a test client reasonably can.
            (Some(method), Some(id)) => {
                let reply = match method {
                    "ping" => json!({"jsonrpc": "2.0", "id": id, "result": {}}),
                    "roots/list" => json!({"jsonrpc": "2.0", "id": id, "result": {"roots": []}}),
                    _ => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("Forge does not support {method}")}}),
                };
                let _ = self.send_raw(reply).await;
            }
            (Some(_), None) => {} // notification; already logged
            (None, Some(id)) => {
                if let Some(n) = id.as_u64() {
                    if let Some(tx) = self.pending.lock().unwrap().remove(&n) {
                        let _ = tx.send(msg);
                    }
                }
            }
            (None, None) => {}
        }
    }

    /// Writes one message to the transport. For Streamable HTTP the reply may arrive inline.
    // Boxed so the send <-> receive recursion has a nameable, `Send` future type.
    fn send_raw(self: &Arc<Self>, msg: Value) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(self.send_raw_inner(msg))
    }

    async fn send_raw_inner(self: &Arc<Self>, msg: Value) -> Result<(), String> {
        self.log("out", msg.clone());
        match &self.transport {
            Transport::Stdio { stdin, .. } => {
                let mut line = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
                line.push(b'\n');
                let mut w = stdin.lock().await;
                w.write_all(&line).await.map_err(|e| format!("stdin: {e}"))?;
                w.flush().await.map_err(|e| format!("stdin: {e}"))
            }
            Transport::Http { client, url, headers, session } => {
                let mut rb = client
                    .post(url)
                    .header("Accept", "application/json, text/event-stream")
                    .header("Content-Type", "application/json")
                    .header("MCP-Protocol-Version", self.protocol.lock().unwrap().clone());
                if let Some(sid) = session.lock().unwrap().clone() {
                    rb = rb.header("Mcp-Session-Id", sid);
                }
                for h in headers.iter().filter(|h| h.enabled && !h.key.is_empty()) {
                    rb = rb.header(&h.key, &h.value);
                }
                let res = rb.json(&msg).send().await.map_err(|e| e.to_string())?;
                if let Some(sid) = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
                    *session.lock().unwrap() = Some(sid.to_string());
                }
                let status = res.status();
                let ctype = res
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                if !status.is_success() {
                    let body = res.text().await.unwrap_or_default();
                    return Err(format!("HTTP {status}: {body}"));
                }
                if ctype.starts_with("text/event-stream") {
                    // Read the stream in the background; responses resolve their pending entry.
                    let me = self.clone();
                    let task = tokio::spawn(async move {
                        let mut parser = SseParser::default();
                        let mut body = res.bytes_stream();
                        while let Some(Ok(chunk)) = body.next().await {
                            for ev in parser.feed(&chunk) {
                                if let Ok(v) = serde_json::from_str::<Value>(&ev.data) {
                                    me.incoming(v).await;
                                }
                            }
                        }
                    });
                    self.track(task.abort_handle());
                } else if ctype.starts_with("application/json") {
                    let text = res.text().await.map_err(|e| e.to_string())?;
                    if !text.trim().is_empty() {
                        let v: Value = serde_json::from_str(&text).map_err(|e| format!("Bad JSON from server: {e}"))?;
                        self.incoming(v).await;
                    }
                }
                Ok(())
            }
            Transport::Sse { client, headers, endpoint, ready } => {
                let url = loop {
                    if let Some(u) = endpoint.lock().unwrap().clone() {
                        break u;
                    }
                    if tokio::time::timeout(Duration::from_secs(15), ready.notified()).await.is_err() {
                        return Err("SSE server never sent an `endpoint` event".into());
                    }
                };
                let mut rb = client.post(&url).header("Content-Type", "application/json");
                for h in headers.iter().filter(|h| h.enabled && !h.key.is_empty()) {
                    rb = rb.header(&h.key, &h.value);
                }
                let res = rb.json(&msg).send().await.map_err(|e| e.to_string())?;
                if !res.status().is_success() {
                    let status = res.status();
                    return Err(format!("HTTP {status}: {}", res.text().await.unwrap_or_default()));
                }
                Ok(())
            }
        }
    }

    pub async fn request(self: &Arc<Self>, method: &str, params: Option<Value>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut msg = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(p) = params {
            msg["params"] = p;
        }
        if let Err(e) = self.send_raw(msg).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err("Session closed before a response arrived".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("Timed out after {}s waiting for {method}", REQUEST_TIMEOUT.as_secs()))
            }
        }
    }

    pub async fn notify(self: &Arc<Self>, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut msg = json!({"jsonrpc": "2.0", "method": method});
        if let Some(p) = params {
            msg["params"] = p;
        }
        self.send_raw(msg).await
    }

    pub async fn shutdown(&self) {
        for h in self.tasks.lock().unwrap().drain(..) {
            h.abort();
        }
        self.pending.lock().unwrap().clear();
        match &self.transport {
            Transport::Stdio { child, .. } => {
                let _ = child.lock().await.kill().await;
            }
            Transport::Http { client, url, session, .. } => {
                let sid = session.lock().unwrap().clone();
                if let Some(sid) = sid {
                    let _ = client.delete(url).header("Mcp-Session-Id", sid).send().await;
                }
            }
            Transport::Sse { .. } => {}
        }
        self.log("info", json!("disconnected"));
    }
}

pub async fn open(sink: Sink, id: String, cfg: McpConfig, client: reqwest::Client) -> Result<Arc<Session>, String> {
    let make = |transport| {
        Arc::new(Session {
            id: id.clone(),
            sink: sink.clone(),
            transport,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            protocol: Mutex::new(PROTOCOL_VERSION.to_string()),
            tasks: Mutex::new(Vec::new()),
            init_result: Mutex::new(Value::Null),
        })
    };
    match cfg {
        McpConfig::Stdio { command, args, env, cwd } => {
            let path = tokio::task::spawn_blocking(shell_path).await.map_err(|e| e.to_string())?;
            let mut cmd = Command::new(&command);
            cmd.args(&args)
                .env("PATH", path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            for e in env.iter().filter(|e| e.enabled && !e.key.is_empty()) {
                cmd.env(&e.key, &e.value);
            }
            if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
                cmd.current_dir(dir);
            }
            let mut child = cmd.spawn().map_err(|e| format!("Failed to start `{command}`: {e}"))?;
            let stdin = child.stdin.take().ok_or("no stdin")?;
            let stdout = child.stdout.take().ok_or("no stdout")?;
            let stderr = child.stderr.take().ok_or("no stderr")?;
            let s = make(Transport::Stdio {
                stdin: tokio::sync::Mutex::new(stdin),
                child: tokio::sync::Mutex::new(child),
            });
            let me = s.clone();
            let out = tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    match serde_json::from_str::<Value>(&line) {
                        Ok(v) => me.incoming(v).await,
                        Err(_) if !line.trim().is_empty() => me.log("stderr", Value::String(line)),
                        Err(_) => {}
                    }
                }
                me.pending.lock().unwrap().clear();
                me.log("info", json!("server process exited"));
            });
            let me = s.clone();
            let err = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    me.log("stderr", Value::String(line));
                }
            });
            s.track(out.abort_handle());
            s.track(err.abort_handle());
            Ok(s)
        }
        McpConfig::Http { url, headers } => {
            Ok(make(Transport::Http { client, url, headers, session: Mutex::new(None) }))
        }
        McpConfig::Sse { url, headers } => {
            let base = url::Url::parse(&url).map_err(|e| e.to_string())?;
            let mut rb = client.get(base.clone()).header("Accept", "text/event-stream");
            for h in headers.iter().filter(|h| h.enabled && !h.key.is_empty()) {
                rb = rb.header(&h.key, &h.value);
            }
            let res = rb.send().await.map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(format!("SSE connect failed: HTTP {}", res.status()));
            }
            let s = make(Transport::Sse {
                client,
                headers,
                endpoint: Mutex::new(None),
                ready: Notify::new(),
            });
            let me = s.clone();
            let task = tokio::spawn(async move {
                let mut parser = SseParser::default();
                let mut body = res.bytes_stream();
                while let Some(Ok(chunk)) = body.next().await {
                    for ev in parser.feed(&chunk) {
                        if ev.event.as_deref() == Some("endpoint") {
                            if let (Ok(u), Transport::Sse { endpoint, ready, .. }) = (base.join(ev.data.trim()), &me.transport) {
                                *endpoint.lock().unwrap() = Some(u.to_string());
                                ready.notify_waiters();
                                me.log("info", json!(format!("endpoint: {u}")));
                            }
                        } else if let Ok(v) = serde_json::from_str::<Value>(&ev.data) {
                            me.incoming(v).await;
                        }
                    }
                }
                me.log("info", json!("SSE stream closed"));
            });
            s.track(task.abort_handle());
            Ok(s)
        }
    }
}

#[tauri::command]
pub async fn mcp_connect(
    app: AppHandle,
    id: String,
    config: McpConfig,
    manager: tauri::State<'_, McpManager>,
    clients: tauri::State<'_, crate::http::Clients>,
) -> Result<Value, String> {
    if let Some(old) = manager.0.lock().unwrap().remove(&id) {
        tokio::spawn(async move { old.shutdown().await });
    }
    let client = clients.get(true, false)?;
    let sink: Sink = Arc::new(move |e| {
        let _ = app.emit("mcp-log", e);
    });
    let s = open(sink, id.clone(), config, client).await?;
    initialize(&s).await?;
    manager.0.lock().unwrap().insert(id, s.clone());
    Ok(s.init_result.lock().unwrap().clone())
}

/// Performs the MCP handshake; shuts the session down if it fails.
pub async fn initialize(s: &Arc<Session>) -> Result<(), String> {
    let init = s
        .request(
            "initialize",
            Some(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"roots": {"listChanged": false}},
                "clientInfo": {"name": "Forge", "version": env!("CARGO_PKG_VERSION")}
            })),
        )
        .await;
    let init = match init {
        Ok(v) if v.get("result").is_some() => v,
        Ok(v) => {
            s.shutdown().await;
            return Err(format!("initialize failed: {}", v.get("error").unwrap_or(&v)));
        }
        Err(e) => {
            s.shutdown().await;
            return Err(e);
        }
    };
    if let Some(v) = init["result"]["protocolVersion"].as_str() {
        *s.protocol.lock().unwrap() = v.to_string();
    }
    *s.init_result.lock().unwrap() = init["result"].clone();
    s.notify("notifications/initialized", None).await
}

fn session(manager: &McpManager, id: &str) -> Result<Arc<Session>, String> {
    manager.0.lock().unwrap().get(id).cloned().ok_or_else(|| "Not connected".to_string())
}

/// Sends any JSON-RPC request; returns the full response message (result or error).
#[tauri::command]
pub async fn mcp_request(
    id: String,
    method: String,
    params: Option<Value>,
    manager: tauri::State<'_, McpManager>,
) -> Result<Value, String> {
    let s = session(&manager, &id)?;
    s.request(&method, params).await
}

#[tauri::command]
pub async fn mcp_notify(
    id: String,
    method: String,
    params: Option<Value>,
    manager: tauri::State<'_, McpManager>,
) -> Result<(), String> {
    let s = session(&manager, &id)?;
    s.notify(&method, params).await
}

#[tauri::command]
pub async fn mcp_disconnect(id: String, manager: tauri::State<'_, McpManager>) -> Result<(), String> {
    let s = manager.0.lock().unwrap().remove(&id);
    if let Some(s) = s {
        s.shutdown().await;
    }
    Ok(())
}
