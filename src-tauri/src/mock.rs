//! Mock server: serves the saved examples of a folder's requests on 127.0.0.1, so a frontend can
//! be built before the backend exists. Routes come from the UI (method, path template, examples)
//! and can be replaced while the server runs. Each call can pick an example with
//! `Prefer: example=<name>` or `Prefer: code=<status>` (as Stoplight Prism does), the
//! `X-Mock-Example` / `X-Mock-Status` headers, or `?__example=` / `?__code=` in the URL.
//!
//! Browsers are only answered for pages served from this computer (localhost, 127.0.0.1, [::1],
//! any port) and origins the user adds. Any website open in the browser runs on this computer
//! too, and saved examples can hold real data, so other origins are refused outright.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MockExample {
    pub name: String,
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MockRoute {
    pub method: String,
    /// Path template; segments like `:id`, `{id}` or `{{id}}` match any value.
    pub path: String,
    /// The request's name, shown when it has no examples yet.
    pub name: String,
    pub examples: Vec<MockExample>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MockLog {
    mock_id: String,
    method: String,
    path: String,
    status: u16,
    example: Option<String>,
    route: Option<String>,
    ts: u128,
}

type Routes = Arc<RwLock<Vec<MockRoute>>>;

type Origins = Arc<RwLock<Vec<String>>>;

struct Ctx {
    id: String,
    routes: Routes,
    origins: Origins,
    app: Option<AppHandle>,
}

struct Running {
    addr: SocketAddr,
    routes: Routes,
    origins: Origins,
    stop: oneshot::Sender<()>,
}

/// A page from this computer's own dev servers, or an origin the user allowed.
fn origin_allowed(origin: &str, extra: &[String]) -> bool {
    let o = origin.trim_end_matches('/');
    if extra.iter().any(|e| e.trim_end_matches('/').eq_ignore_ascii_case(o)) {
        return true;
    }
    let Ok(u) = url::Url::parse(o) else { return false };
    matches!(u.scheme(), "http" | "https") && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"))
}

#[derive(Default)]
pub struct MockManager(Mutex<HashMap<String, Running>>);

fn is_param(seg: &str) -> bool {
    seg.starts_with(':') || (seg.starts_with('{') && seg.ends_with('}'))
}

fn segments(path: &str) -> Vec<&str> {
    path.split('/').filter(|s| !s.is_empty()).collect()
}

/// The best route for a request: same method (HEAD matches GET) and path shape, preferring the
/// most literal segments, then the first defined.
fn find<'a>(routes: &'a [MockRoute], method: &Method, path: &str) -> Option<&'a MockRoute> {
    let want = segments(path);
    let mut best: Option<(&MockRoute, usize)> = None;
    for r in routes {
        let m = r.method.to_ascii_uppercase();
        if m != method.as_str() && !(method == Method::HEAD && m == "GET") {
            continue;
        }
        let have = segments(&r.path);
        if have.len() != want.len() {
            continue;
        }
        let mut literal = 0;
        let ok = have.iter().zip(&want).all(|(h, w)| {
            if is_param(h) {
                true
            } else if h.eq_ignore_ascii_case(w) || percent_decode(w).eq_ignore_ascii_case(h) {
                literal += 1;
                true
            } else {
                false
            }
        });
        if ok && best.is_none_or(|(_, n)| literal > n) {
            best = Some((r, literal));
        }
    }
    best.map(|(r, _)| r)
}

fn percent_decode(s: &str) -> String {
    url::form_urlencoded::parse(format!("x={s}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default()
}

fn query_param(uri: &Uri, name: &str) -> Option<String> {
    url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

/// Which example to serve: asked for by name or status, else the first (the default).
fn choose<'a>(route: &'a MockRoute, headers: &HeaderMap, uri: &Uri) -> Option<&'a MockExample> {
    let h = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).map(str::trim).map(String::from);
    let mut name = query_param(uri, "__example").or_else(|| h("x-mock-example"));
    let mut code = query_param(uri, "__code").or_else(|| h("x-mock-status"));
    if let Some(prefer) = h("prefer") {
        for part in prefer.split([',', ';']) {
            let (k, v) = part.split_once('=').map(|(k, v)| (k.trim(), v.trim().trim_matches('"'))).unwrap_or(("", ""));
            if k.eq_ignore_ascii_case("example") && name.is_none() {
                name = Some(v.to_string());
            }
            if k.eq_ignore_ascii_case("code") && code.is_none() {
                code = Some(v.to_string());
            }
        }
    }
    if let Some(n) = name {
        if let Some(e) = route.examples.iter().find(|e| e.name.eq_ignore_ascii_case(&n)) {
            return Some(e);
        }
    }
    if let Some(c) = code.and_then(|c| c.parse::<u16>().ok()) {
        if let Some(e) = route.examples.iter().find(|e| e.status == c) {
            return Some(e);
        }
    }
    route.examples.first()
}

fn cors(headers: &mut HeaderMap, req: &HeaderMap) {
    let origin = req.get(header::ORIGIN).cloned().unwrap_or(HeaderValue::from_static("*"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, HeaderValue::from_static("true"));
    headers.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, HeaderValue::from_static("*"));
}

fn json_response(status: StatusCode, body: serde_json::Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

/// Only requests addressed to localhost: a page on another site can't reach the mock by
/// pointing its own domain at 127.0.0.1 (DNS rebinding).
fn local_host(headers: &HeaderMap) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let name = host.rsplit_once(':').map(|(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host }).unwrap_or(host);
    matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

async fn handle(State(ctx): State<Arc<Ctx>>, req: Request<Body>) -> Response {
    let (method, uri, headers) = (req.method().clone(), req.uri().clone(), req.headers().clone());
    if !local_host(&headers) {
        return (StatusCode::FORBIDDEN, "Mock server only answers requests to localhost").into_response();
    }
    // No Origin: curl, server-side code, emulators. With one, it must be a local page or allowed.
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if !origin_allowed(origin, &ctx.origins.read().unwrap()) {
            return json_response(StatusCode::FORBIDDEN, json!({ "error": format!("The mock server doesn't answer pages from {origin}. Allow this origin in Forge's mock server panel if it's yours.") }));
        }
    }
    let path = uri.path().to_string();
    if method == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        cors(res.headers_mut(), &headers);
        let allow = headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS).cloned().unwrap_or(HeaderValue::from_static("*"));
        res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_HEADERS, allow);
        res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS"));
        res.headers_mut().insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
        return res;
    }
    let (mut res, example, route) = {
        let routes = ctx.routes.read().unwrap();
        match find(&routes, &method, &path) {
            None => {
                let known: Vec<String> = routes.iter().map(|r| format!("{} {}", r.method.to_ascii_uppercase(), r.path)).collect();
                (json_response(StatusCode::NOT_FOUND, json!({ "error": format!("No mock for {method} {path}"), "routes": known })), None, None)
            }
            Some(r) => match choose(r, &headers, &uri) {
                None => (
                    json_response(StatusCode::NOT_IMPLEMENTED, json!({ "error": format!("\"{}\" has no saved examples yet. In Forge, send it and save the response as an example.", r.name) })),
                    None,
                    Some(r.path.clone()),
                ),
                Some(e) => {
                    let status = StatusCode::from_u16(e.status).unwrap_or(StatusCode::OK);
                    let body = if method == Method::HEAD { Body::empty() } else { Body::from(e.body.clone()) };
                    let mut res = Response::builder().status(status).body(body).unwrap();
                    for (k, v) in &e.headers {
                        if matches!(k.to_ascii_lowercase().as_str(), "content-length" | "transfer-encoding" | "connection" | "content-encoding") {
                            continue;
                        }
                        if let (Ok(n), Ok(v)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
                            res.headers_mut().append(n, v);
                        }
                    }
                    if let Ok(v) = HeaderValue::from_str(&e.name) {
                        res.headers_mut().insert("x-forge-mock", v);
                    }
                    (res, Some(e.name.clone()), Some(r.path.clone()))
                }
            },
        }
    };
    cors(res.headers_mut(), &headers);
    if let Some(app) = &ctx.app {
        let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let _ = app.emit("mock-log", MockLog { mock_id: ctx.id.clone(), method: method.to_string(), path: uri.to_string(), status: res.status().as_u16(), example, route, ts });
    }
    res
}

pub async fn serve(id: String, port: u16, routes: Routes, origins: Origins, app: Option<AppHandle>) -> Result<(SocketAddr, oneshot::Sender<()>), String> {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        // The usual port is taken (another mock, a dev server): take any free one.
        Err(_) if port != 0 => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?,
        Err(e) => return Err(e.to_string()),
    };
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let app = Router::new().fallback(handle).with_state(Arc::new(Ctx { id, routes, origins, app }));
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

#[tauri::command]
pub async fn mock_start(app: AppHandle, id: String, port: u16, routes: Vec<MockRoute>, origins: Vec<String>, manager: tauri::State<'_, MockManager>) -> Result<String, String> {
    if let Some(r) = manager.0.lock().unwrap().remove(&id) {
        let _ = r.stop.send(());
    }
    let shared: Routes = Arc::new(RwLock::new(routes));
    let allowed: Origins = Arc::new(RwLock::new(origins));
    let (addr, stop) = serve(id.clone(), port, shared.clone(), allowed.clone(), Some(app)).await?;
    manager.0.lock().unwrap().insert(id, Running { addr, routes: shared, origins: allowed, stop });
    Ok(format!("http://{addr}"))
}

/// Replaces the routes (requests or examples changed) and allowed origins of a running mock.
#[tauri::command]
pub fn mock_update(id: String, routes: Vec<MockRoute>, origins: Vec<String>, manager: tauri::State<'_, MockManager>) -> bool {
    match manager.0.lock().unwrap().get(&id) {
        Some(r) => {
            *r.routes.write().unwrap() = routes;
            *r.origins.write().unwrap() = origins;
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn mock_stop(id: String, manager: tauri::State<'_, MockManager>) {
    if let Some(r) = manager.0.lock().unwrap().remove(&id) {
        let _ = r.stop.send(());
    }
}

/// URLs of the mocks that are running, by id.
#[tauri::command]
pub fn mock_list(manager: tauri::State<'_, MockManager>) -> HashMap<String, String> {
    manager.0.lock().unwrap().iter().map(|(k, r)| (k.clone(), format!("http://{}", r.addr))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ex(name: &str, status: u16, body: &str) -> MockExample {
        MockExample { name: name.into(), status, headers: vec![("Content-Type".into(), "application/json".into())], body: body.into() }
    }
    fn route(method: &str, path: &str, examples: Vec<MockExample>) -> MockRoute {
        MockRoute { method: method.into(), path: path.into(), name: format!("{method} {path}"), examples }
    }

    #[test]
    fn matches_templates_preferring_literal_segments() {
        let routes = vec![route("GET", "/users/:id", vec![]), route("GET", "/users/me", vec![]), route("GET", "/users/{{userId}}/posts", vec![]), route("POST", "/users", vec![])];
        assert_eq!(find(&routes, &Method::GET, "/users/42").unwrap().path, "/users/:id");
        assert_eq!(find(&routes, &Method::GET, "/users/me").unwrap().path, "/users/me");
        assert_eq!(find(&routes, &Method::GET, "/users/7/posts/").unwrap().path, "/users/{{userId}}/posts");
        assert_eq!(find(&routes, &Method::HEAD, "/users/1").unwrap().path, "/users/:id");
        assert!(find(&routes, &Method::DELETE, "/users/1").is_none());
        assert!(find(&routes, &Method::GET, "/orders").is_none());
    }

    #[test]
    fn chooses_examples_by_name_status_or_default() {
        let r = route("GET", "/u", vec![ex("Found", 200, "{}"), ex("Missing", 404, "{}")]);
        let uri: Uri = "/u".parse().unwrap();
        let mut h = HeaderMap::new();
        assert_eq!(choose(&r, &h, &uri).unwrap().name, "Found");
        h.insert("prefer", HeaderValue::from_static("code=404"));
        assert_eq!(choose(&r, &h, &uri).unwrap().name, "Missing");
        h.insert("prefer", HeaderValue::from_static("example=\"found\""));
        assert_eq!(choose(&r, &h, &uri).unwrap().name, "Found");
        let uri: Uri = "/u?__example=Missing".parse().unwrap();
        assert_eq!(choose(&r, &HeaderMap::new(), &uri).unwrap().name, "Missing");
        let uri: Uri = "/u?__code=500".parse().unwrap();
        assert_eq!(choose(&r, &HeaderMap::new(), &uri).unwrap().name, "Found");
    }

    #[test]
    fn only_answers_localhost() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4010"));
        assert!(local_host(&h));
        h.insert(header::HOST, HeaderValue::from_static("localhost"));
        assert!(local_host(&h));
        h.insert(header::HOST, HeaderValue::from_static("evil.example:4010"));
        assert!(!local_host(&h));
    }

    #[test]
    fn answers_only_local_or_allowed_origins() {
        let none: Vec<String> = vec![];
        assert!(origin_allowed("http://localhost:5173", &none));
        assert!(origin_allowed("http://127.0.0.1:3000", &none));
        assert!(origin_allowed("https://localhost", &none));
        assert!(!origin_allowed("https://evil.example", &none));
        assert!(!origin_allowed("http://localhost.evil.example", &none));
        assert!(!origin_allowed("null", &none));
        assert!(origin_allowed("https://app.dev.test", &["https://app.dev.test/".into()]));
    }

    #[tokio::test]
    async fn serves_examples_over_http_with_cors() {
        let routes: Routes = Arc::new(RwLock::new(vec![route("GET", "/users/:id", vec![ex("Found", 200, r#"{"id":1}"#), ex("Missing", 404, r#"{"error":"no"}"#)]), route("POST", "/users", vec![])]));
        let (addr, stop) = serve("t".into(), 0, routes.clone(), Arc::default(), None).await.unwrap();
        let c = reqwest::Client::new();
        let base = format!("http://{addr}");
        let r = c.get(format!("{base}/users/5")).header("Origin", "http://localhost:5173").send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["access-control-allow-origin"], "http://localhost:5173");
        assert_eq!(r.headers()["x-forge-mock"], "Found");
        assert_eq!(r.text().await.unwrap(), r#"{"id":1}"#);
        let r = c.get(format!("{base}/users/5")).header("Prefer", "code=404").send().await.unwrap();
        assert_eq!(r.status(), 404);
        let r = c.post(format!("{base}/users")).send().await.unwrap();
        assert_eq!(r.status(), 501);
        assert!(r.text().await.unwrap().contains("no saved examples"));
        let r = c.get(format!("{base}/nope")).send().await.unwrap();
        assert_eq!(r.status(), 404);
        assert!(r.text().await.unwrap().contains("GET /users/:id"));
        let r = c.request(reqwest::Method::OPTIONS, format!("{base}/users/5")).header("Origin", "http://localhost:5173").header("Access-Control-Request-Headers", "authorization").send().await.unwrap();
        assert_eq!(r.status(), 204);
        assert_eq!(r.headers()["access-control-allow-headers"], "authorization");
        // A page on some other website open in the same browser gets nothing, preflight or not.
        let r = c.get(format!("{base}/users/5")).header("Origin", "https://evil.example").send().await.unwrap();
        assert_eq!(r.status(), 403);
        assert!(r.headers().get("access-control-allow-origin").is_none());
        let r = c.request(reqwest::Method::OPTIONS, format!("{base}/users/5")).header("Origin", "https://evil.example").send().await.unwrap();
        assert_eq!(r.status(), 403);
        // Routes can change while it runs.
        *routes.write().unwrap() = vec![route("GET", "/health", vec![ex("Up", 200, "ok")])];
        assert_eq!(c.get(format!("{base}/health")).send().await.unwrap().text().await.unwrap(), "ok");
        let _ = stop.send(());
    }
}
