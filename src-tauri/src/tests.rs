//! End-to-end tests of the network engine against throwaway local servers.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::http::{self, Body, HttpRequest, Kv};
use crate::mcp::{self, LogEvent, McpConfig, Sink};

fn client() -> reqwest::Client {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    http::Clients::default().get(true, false).unwrap()
}

fn sink() -> (Sink, Arc<Mutex<Vec<LogEvent>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let l = log.clone();
    (Arc::new(move |e| l.lock().unwrap().push(e)), log)
}

/// Reads one HTTP/1.1 request; returns (head, body).
async fn read_request(sock: &mut tokio::net::TcpStream) -> (String, String) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = sock.read(&mut tmp).await.unwrap();
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..i]).to_string();
            let len = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                .unwrap_or(0);
            while buf.len() < i + 4 + len {
                let n = sock.read(&mut tmp).await.unwrap();
                buf.extend_from_slice(&tmp[..n]);
            }
            return (head, String::from_utf8_lossy(&buf[i + 4..i + 4 + len]).to_string());
        }
    }
    (String::new(), String::new())
}

#[tokio::test]
async fn http_roundtrip_with_body_headers_and_timing() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let (head, body) = read_request(&mut sock).await;
        let echo = json!({ "line": head.lines().next(), "body": body, "auth": head.lines().any(|l| l.eq_ignore_ascii_case("authorization: Bearer t0k")) }).to_string();
        let res = format!("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nX-Test: yes\r\nContent-Length: {}\r\n\r\n{}", echo.len(), echo);
        sock.write_all(res.as_bytes()).await.unwrap();
    });
    let res = http::execute(
        client(),
        HttpRequest {
            method: "post".into(),
            url: format!("http://{addr}/users?x=1"),
            headers: vec![Kv { key: "Authorization".into(), value: "Bearer t0k".into(), enabled: true }],
            body: Some(Body::Raw { content: r#"{"name":"a"}"#.into() }),
            timeout_ms: Some(5000),
            follow_redirects: true,
            insecure: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(res.status, 201);
    assert!(res.headers.iter().any(|h| h.key == "x-test" && h.value == "yes"));
    let v: Value = serde_json::from_str(&res.body).unwrap();
    assert_eq!(v["line"], "POST /users?x=1 HTTP/1.1");
    assert_eq!(v["body"], r#"{"name":"a"}"#);
    assert_eq!(v["auth"], true);
    assert!(res.time_ms > 0.0 && res.ttfb_ms <= res.time_ms);
}

#[tokio::test]
async fn http_connection_error_is_descriptive() {
    let err = http::execute(client(), HttpRequest {
        method: "GET".into(),
        url: "http://127.0.0.1:1/".into(),
        headers: vec![],
        body: None,
        timeout_ms: Some(2000),
        follow_redirects: true,
        insecure: false,
    })
    .await
    .unwrap_err();
    assert!(err.to_lowercase().contains("connect"), "{err}");
}

const MOCK_STDIO_SERVER: &str = r#"
import sys, json
def send(m): sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
print("mock server booting", file=sys.stderr, flush=True)
for line in sys.stdin:
    m = json.loads(line)
    meth, mid = m.get("method"), m.get("id")
    if meth == "initialize":
        send({"jsonrpc":"2.0","id":mid,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"mock","version":"1.0"}}})
    elif meth == "notifications/initialized":
        send({"jsonrpc":"2.0","id":"srv-1","method":"ping"})  # server -> client request
    elif meth == "tools/list":
        send({"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"listing"}})
        send({"jsonrpc":"2.0","id":mid,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}})
    elif meth == "tools/call":
        send({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":m["params"]["arguments"]["text"]}]}})
    elif mid is not None and meth is None:
        pass  # response to our ping
    elif mid is not None:
        send({"jsonrpc":"2.0","id":mid,"error":{"code":-32601,"message":"nope"}})
"#;

#[tokio::test]
async fn mcp_stdio_handshake_tools_and_server_requests() {
    let dir = std::env::temp_dir().join(format!("forge-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("server.py");
    std::fs::write(&script, MOCK_STDIO_SERVER).unwrap();

    let (sink, log) = sink();
    let cfg = McpConfig::Stdio { command: "python3".into(), args: vec!["-I".into(), script.to_string_lossy().into()], env: vec![], cwd: None };
    let s = mcp::open(sink, "t".into(), cfg, client()).await.unwrap();
    mcp::initialize(&s).await.unwrap();

    let tools = s.request("tools/list", Some(json!({}))).await.unwrap();
    assert_eq!(tools["result"]["tools"][0]["name"], "echo");
    let call = s.request("tools/call", Some(json!({"name": "echo", "arguments": {"text": "hi"}}))).await.unwrap();
    assert_eq!(call["result"]["content"][0]["text"], "hi");
    let unknown = s.request("bogus/method", None).await.unwrap();
    assert_eq!(unknown["error"]["code"], -32601);

    let log = log.lock().unwrap().clone();
    // The client must answer the server's ping with an empty result.
    assert!(log.iter().any(|e| e.dir == "out" && e.message["id"] == "srv-1" && e.message["result"] == json!({})));
    assert!(log.iter().any(|e| e.dir == "in" && e.message["method"] == "notifications/message"));
    assert!(log.iter().any(|e| e.dir == "stderr" && e.message == "mock server booting"));
    s.shutdown().await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn mcp_streamable_http_json_and_sse_responses() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen_session = Arc::new(Mutex::new(Vec::<bool>::new()));
    let seen = seen_session.clone();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let seen = seen.clone();
            tokio::spawn(async move {
                loop {
                    let (head, body) = read_request(&mut sock).await;
                    if head.is_empty() {
                        return;
                    }
                    let lower = head.to_ascii_lowercase();
                    seen.lock().unwrap().push(lower.contains("mcp-session-id: sess-42"));
                    let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    let res = match msg["method"].as_str() {
                        Some("initialize") => {
                            let b = json!({"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"http-mock","version":"2"}}}).to_string();
                            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: sess-42\r\nContent-Length: {}\r\n\r\n{b}", b.len())
                        }
                        Some("tools/call") => {
                            // SSE reply: a progress notification, then the response.
                            let note = json!({"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}});
                            let reply = json!({"jsonrpc":"2.0","id":msg["id"],"result":{"content":[{"type":"text","text":"streamed"}]}});
                            let b = format!("event: message\ndata: {note}\n\nevent: message\ndata: {reply}\n\n");
                            format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{b}", b.len())
                        }
                        _ => "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n".to_string(),
                    };
                    if sock.write_all(res.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });

    let (sink, log) = sink();
    let s = mcp::open(sink, "h".into(), McpConfig::Http { url: format!("http://{addr}/mcp"), headers: vec![] }, client()).await.unwrap();
    mcp::initialize(&s).await.unwrap();
    let r = s.request("tools/call", Some(json!({"name": "x", "arguments": {}}))).await.unwrap();
    assert_eq!(r["result"]["content"][0]["text"], "streamed");
    assert!(log.lock().unwrap().iter().any(|e| e.message["method"] == "notifications/progress"));
    // First request has no session; every later one must carry the issued session id.
    let seen = seen_session.lock().unwrap().clone();
    assert_eq!(seen[0], false);
    assert!(seen[1..].iter().all(|x| *x), "{seen:?}");
}

mod server_tests {
    use crate::server::{serve, Bridge, BridgeCall, ServerConfig};
    use serde_json::{json, Value};
    use std::sync::Arc;

    async fn start() -> String {
        let bridge: Bridge = Arc::new(|c: BridgeCall| {
            Box::pin(async move {
                match (c.kind.as_str(), c.name.as_str()) {
                    ("tool", "echo") => Ok(json!({ "content": [{ "type": "text", "text": format!("{} says {}", c.client, c.args["text"].as_str().unwrap_or("")) }] })),
                    ("tool", _) => Err("boom".into()),
                    _ => Ok(json!({ "kind": "message", "role": "agent", "messageId": "m1", "parts": [{ "kind": "text", "text": "hi from forge" }] })),
                }
            })
        });
        let cfg = ServerConfig {
            port: 0,
            token: "t0k3n-t0k3n-t0k3n-t0k3n".into(),
            tools: vec![json!({ "name": "echo", "inputSchema": { "type": "object" } }), json!({ "name": "fail", "inputSchema": { "type": "object" } })],
            card: json!({ "name": "Forge", "skills": [] }),
            instructions: "Use Forge".into(),
        };
        let (addr, stop) = serve(cfg, bridge).await.unwrap();
        std::mem::forget(stop); // keep running for the test
        format!("http://{addr}")
    }

    async fn rpc(c: &reqwest::Client, url: &str, token: &str, sid: Option<&str>, body: Value) -> reqwest::Response {
        let mut r = c.post(url).bearer_auth(token).json(&body);
        if let Some(s) = sid {
            r = r.header("mcp-session-id", s);
        }
        r.send().await.unwrap()
    }

    #[tokio::test]
    async fn mcp_and_a2a_round_trip() {
        let base = start().await;
        let c = reqwest::Client::new();
        let tok = "t0k3n-t0k3n-t0k3n-t0k3n";
        let mcp = format!("{base}/mcp");

        // Auth and origin guards.
        assert_eq!(c.post(&mcp).json(&json!({})).send().await.unwrap().status(), 401);
        assert_eq!(rpc(&c, &mcp, "wrong-token-wrong-token", None, json!({})).await.status(), 401);
        let evil = c.post(&mcp).bearer_auth(tok).header("Origin", "https://evil.example").json(&json!({})).send().await.unwrap();
        assert_eq!(evil.status(), 403);

        // Handshake: version negotiation and session id.
        let init = rpc(&c, &mcp, tok, None, json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26", "clientInfo": { "name": "cursor" }, "capabilities": {} } })).await;
        let sid = init.headers()["mcp-session-id"].to_str().unwrap().to_owned();
        let v: Value = init.json().await.unwrap();
        assert_eq!(v["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(v["result"]["serverInfo"]["name"], "forge");
        assert_eq!(rpc(&c, &mcp, tok, Some(&sid), json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.status(), 202);

        let v: Value = rpc(&c, &mcp, tok, Some(&sid), json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await.json().await.unwrap();
        assert_eq!(v["result"]["tools"].as_array().unwrap().len(), 2);
        let v: Value = rpc(&c, &mcp, tok, Some(&sid), json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "echo", "arguments": { "text": "hello" } } })).await.json().await.unwrap();
        assert_eq!(v["result"]["content"][0]["text"], "cursor says hello");
        let v: Value = rpc(&c, &mcp, tok, Some(&sid), json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "fail" } })).await.json().await.unwrap();
        assert_eq!(v["result"]["isError"], true);
        let v: Value = rpc(&c, &mcp, tok, Some(&sid), json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "nope" } })).await.json().await.unwrap();
        assert_eq!(v["error"]["code"], -32602);
        let v: Value = rpc(&c, &mcp, tok, Some(&sid), json!({ "jsonrpc": "2.0", "id": 6, "method": "resources/list" })).await.json().await.unwrap();
        assert_eq!(v["error"]["code"], -32601);
        assert_eq!(c.get(&mcp).bearer_auth(tok).send().await.unwrap().status(), 405);

        // A2A: public card points at the authenticated JSON-RPC endpoint.
        let card: Value = c.get(format!("{base}/.well-known/agent-card.json")).send().await.unwrap().json().await.unwrap();
        assert_eq!(card["url"], format!("{base}/a2a"));
        let v: Value = rpc(&c, &format!("{base}/a2a"), tok, None, json!({ "jsonrpc": "2.0", "id": "x", "method": "message/send", "params": { "message": { "role": "user", "parts": [{ "kind": "text", "text": "hi" }] } } })).await.json().await.unwrap();
        assert_eq!(v["result"]["parts"][0]["text"], "hi from forge");
    }
}
