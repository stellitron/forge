//! Forge as a server: a localhost MCP endpoint (Streamable HTTP, JSON responses) and an A2A
//! agent, so Claude, VS Code, Cursor, Copilot or any A2A client can drive your workspace.
//!
//! The server only speaks the protocols. Every tool call and agent message is forwarded to the
//! UI through a `Bridge`, which runs it with the same code as the app (and asks the user for
//! approval where needed), so behaviour never diverges between the app and external clients.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

const PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCall {
    pub id: String,
    /// "tool" for MCP tools/call, "a2a" for an A2A JSON-RPC method.
    pub kind: String,
    pub name: String,
    pub args: Value,
    /// Who is calling, e.g. "claude-code" from MCP clientInfo, or "A2A client".
    pub client: String,
}

pub type Bridge = Arc<dyn Fn(BridgeCall) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub port: u16,
    pub token: String,
    /// MCP tool definitions ({name, description, inputSchema, annotations}).
    pub tools: Vec<Value>,
    /// A2A agent card without `url`; the server fills in its own endpoint.
    pub card: Value,
    pub instructions: String,
}

struct Ctx {
    cfg: ServerConfig,
    bridge: Bridge,
    base: String,
    clients: Mutex<HashMap<String, String>>, // MCP session id → client name
}

type Shared = Arc<Ctx>;

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Bearer token plus an Origin check: browsers on other sites must not reach the local server.
fn guard(ctx: &Ctx, headers: &HeaderMap) -> Result<(), Response> {
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let host = url::Url::parse(origin).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
        if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1") {
            return Err((StatusCode::FORBIDDEN, "Origin not allowed").into_response());
        }
    }
    let ok = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| constant_eq(t.trim().as_bytes(), ctx.cfg.token.as_bytes()));
    if !ok {
        let mut r = (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Missing or wrong bearer token. Copy it from Forge → Settings → Connect AI tools." }))).into_response();
        r.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer realm=\"forge\""));
        return Err(r);
    }
    Ok(())
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn parse(body: &Bytes) -> Result<Value, Response> {
    serde_json::from_slice(body).map_err(|e| (StatusCode::BAD_REQUEST, Json(rpc_error(&Value::Null, -32700, &format!("Parse error: {e}")))).into_response())
}

async fn mcp_post(State(ctx): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if let Err(r) = guard(&ctx, &headers) {
        return r;
    }
    let msg = match parse(&body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    if msg.is_array() {
        return Json(rpc_error(&Value::Null, -32600, "Batching is not supported")).into_response();
    }
    let method = msg["method"].as_str().unwrap_or_default().to_owned();
    let Some(id) = msg.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response(); // notifications and responses
    };
    let session = headers.get("mcp-session-id").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    match method.as_str() {
        "initialize" => {
            let asked = msg["params"]["protocolVersion"].as_str().unwrap_or_default();
            let version = if PROTOCOLS.contains(&asked) { asked } else { PROTOCOLS[0] };
            let sid = uuid::Uuid::new_v4().simple().to_string();
            let client = msg["params"]["clientInfo"]["name"].as_str().unwrap_or("MCP client").to_owned();
            ctx.clients.lock().unwrap().insert(sid.clone(), client);
            let result = json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "forge", "title": "Forge API workspace", "version": env!("CARGO_PKG_VERSION") },
                "instructions": ctx.cfg.instructions,
            });
            let mut r = Json(rpc_result(&id, result)).into_response();
            r.headers_mut().insert("mcp-session-id", HeaderValue::from_str(&sid).unwrap());
            r
        }
        "ping" => Json(rpc_result(&id, json!({}))).into_response(),
        "tools/list" => Json(rpc_result(&id, json!({ "tools": ctx.cfg.tools }))).into_response(),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or_default().to_owned();
            if !ctx.cfg.tools.iter().any(|t| t["name"] == name.as_str()) {
                return Json(rpc_error(&id, -32602, &format!("Unknown tool: {name}"))).into_response();
            }
            let client = ctx.clients.lock().unwrap().get(&session).cloned().unwrap_or_else(|| "MCP client".into());
            let call = BridgeCall { id: uuid::Uuid::new_v4().to_string(), kind: "tool".into(), name, args: msg["params"]["arguments"].clone(), client };
            let result = match (ctx.bridge)(call).await {
                Ok(v) => v,
                Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
            };
            Json(rpc_result(&id, result)).into_response()
        }
        _ => Json(rpc_error(&id, -32601, &format!("Method not found: {method}"))).into_response(),
    }
}

async fn mcp_other() -> Response {
    // No server-initiated stream: every reply comes back on the POST.
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST, DELETE")]).into_response()
}

async fn mcp_delete(State(ctx): State<Shared>, headers: HeaderMap) -> Response {
    if let Err(r) = guard(&ctx, &headers) {
        return r;
    }
    if let Some(s) = headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        ctx.clients.lock().unwrap().remove(s);
    }
    StatusCode::NO_CONTENT.into_response()
}

fn card(ctx: &Ctx) -> Value {
    let mut c = ctx.cfg.card.clone();
    c["url"] = json!(format!("{}/a2a", ctx.base));
    c["preferredTransport"] = json!("JSONRPC");
    c["securitySchemes"] = json!({ "bearer": { "type": "http", "scheme": "bearer" } });
    c["security"] = json!([{ "bearer": [] }]);
    c
}

async fn agent_card(State(ctx): State<Shared>) -> Response {
    Json(card(&ctx)).into_response()
}

async fn a2a_post(State(ctx): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    if let Err(r) = guard(&ctx, &headers) {
        return r;
    }
    let msg = match parse(&body) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let method = msg["method"].as_str().unwrap_or_default();
    match method {
        "message/send" => {
            let call = BridgeCall { id: uuid::Uuid::new_v4().to_string(), kind: "a2a".into(), name: method.into(), args: msg["params"].clone(), client: "A2A client".into() };
            match (ctx.bridge)(call).await {
                Ok(v) => Json(rpc_result(&id, v)).into_response(),
                Err(e) => Json(rpc_error(&id, -32603, &e)).into_response(),
            }
        }
        "message/stream" | "tasks/resubscribe" => Json(rpc_error(&id, -32004, "Streaming is not supported; use message/send")).into_response(),
        "tasks/get" | "tasks/cancel" => Json(rpc_error(&id, -32001, "Task not found: Forge answers every message synchronously")).into_response(),
        "agent/getAuthenticatedExtendedCard" => Json(rpc_result(&id, card(&ctx))).into_response(),
        _ => Json(rpc_error(&id, -32601, &format!("Method not found: {method}"))).into_response(),
    }
}

pub fn router(cfg: ServerConfig, bridge: Bridge, base: String) -> Router {
    let ctx = Arc::new(Ctx { cfg, bridge, base, clients: Mutex::new(HashMap::new()) });
    Router::new()
        .route("/mcp", post(mcp_post).get(mcp_other).delete(mcp_delete))
        .route("/.well-known/agent-card.json", get(agent_card))
        .route("/.well-known/agent.json", get(agent_card))
        .route("/a2a", post(a2a_post))
        .with_state(ctx)
}

/// Binds 127.0.0.1 only. Returns the bound address and a handle that stops the server when dropped/sent.
pub async fn serve(cfg: ServerConfig, bridge: Bridge) -> Result<(SocketAddr, oneshot::Sender<()>), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", cfg.port)).await.map_err(|e| format!("Can't listen on 127.0.0.1:{}: {e}", cfg.port))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let app = router(cfg, bridge, format!("http://{addr}"));
    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok((addr, tx))
}

// ───────────────────────── Tauri glue ─────────────────────────

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Default)]
pub struct ServerState {
    running: Mutex<Option<(SocketAddr, oneshot::Sender<()>)>>,
    pending: Pending,
}

#[derive(Serialize)]
pub struct ServerStatus {
    running: bool,
    url: Option<String>,
}

/// Forwards calls to the UI as `forge-server-call` events and waits for `server_reply`.
fn ui_bridge(app: AppHandle, pending: Pending) -> Bridge {
    Arc::new(move |call: BridgeCall| {
        let app = app.clone();
        let pending = pending.clone();
        Box::pin(async move {
            let (tx, rx) = oneshot::channel();
            pending.lock().unwrap().insert(call.id.clone(), tx);
            let id = call.id.clone();
            if let Err(e) = app.emit("forge-server-call", call) {
                pending.lock().unwrap().remove(&id);
                return Err(e.to_string());
            }
            // Long enough for a person to approve a request.
            match tokio::time::timeout(Duration::from_secs(600), rx).await {
                Ok(Ok(r)) => r,
                _ => {
                    pending.lock().unwrap().remove(&id);
                    Err("Forge did not answer in time (is the app window open?)".into())
                }
            }
        })
    })
}

#[tauri::command]
pub async fn server_start(app: AppHandle, config: ServerConfig, state: tauri::State<'_, ServerState>) -> Result<ServerStatus, String> {
    if let Some((_, stop)) = state.running.lock().unwrap().take() {
        let _ = stop.send(());
    }
    if config.token.len() < 16 {
        return Err("Token too short".into());
    }
    let (addr, stop) = serve(config, ui_bridge(app, state.pending.clone())).await?;
    *state.running.lock().unwrap() = Some((addr, stop));
    Ok(ServerStatus { running: true, url: Some(format!("http://{addr}")) })
}

#[tauri::command]
pub fn server_stop(state: tauri::State<'_, ServerState>) -> ServerStatus {
    if let Some((_, stop)) = state.running.lock().unwrap().take() {
        let _ = stop.send(());
    }
    ServerStatus { running: false, url: None }
}

#[tauri::command]
pub fn server_reply(id: String, ok: bool, value: Value, state: tauri::State<'_, ServerState>) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(if ok { Ok(value) } else { Err(value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string())) });
    }
}
