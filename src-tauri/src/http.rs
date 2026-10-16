//! HTTP engine: one-shot requests (with timings) and streamed responses.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::task::AbortHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Kv {
    pub key: String,
    pub value: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartField {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub file: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Body {
    None,
    Raw { content: String },
    Form { fields: Vec<Kv> },
    Multipart { fields: Vec<MultipartField> },
    Binary { path: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<Kv>,
    #[serde(default)]
    pub body: Option<Body>,
    pub timeout_ms: Option<u64>,
    #[serde(default = "yes")]
    pub follow_redirects: bool,
    #[serde(default)]
    pub insecure: bool,
    /// PEM files for mutual TLS.
    #[serde(default)]
    pub client_cert: Option<ClientCert>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ClientCert {
    pub cert: String,
    pub key: String,
    #[serde(default)]
    pub ca: Option<String>,
}

fn read_pem(path: &str, what: &str) -> Result<Vec<u8>, String> {
    let path = path.trim();
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => std::env::var("HOME").map(|h| format!("{h}/{rest}")).unwrap_or_else(|_| path.to_string()),
        None => path.to_string(),
    };
    std::fs::read(&expanded).map_err(|e| format!("Couldn't read the {what} file {expanded}: {e}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub http_version: String,
    pub url: String,
    pub headers: Vec<Kv>,
    pub body: String,
    pub body_base64: bool,
    pub size: usize,
    pub time_ms: f64,
    pub ttfb_ms: f64,
}

/// Clients are cached per (follow_redirects, insecure, client certificate) so connections and
/// cookies are reused.
/// Clients by (follow redirects, accept invalid certs, client certificate).
type ClientMap = HashMap<(bool, bool, Option<ClientCert>), reqwest::Client>;

#[derive(Default)]
pub struct Clients(Mutex<ClientMap>, std::sync::Arc<crate::cookies::Jar>);

impl Clients {
    /// The cookie jar every client shares.
    pub fn jar(&self) -> std::sync::Arc<crate::cookies::Jar> {
        self.1.clone()
    }

    pub fn get(&self, follow: bool, insecure: bool) -> Result<reqwest::Client, String> {
        self.get_with(follow, insecure, None)
    }

    pub fn get_with(&self, follow: bool, insecure: bool, cert: Option<&ClientCert>) -> Result<reqwest::Client, String> {
        let key = (follow, insecure, cert.cloned());
        let mut map = self.0.lock().unwrap();
        if let Some(c) = map.get(&key) {
            return Ok(c.clone());
        }
        let policy = if follow {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        };
        let mut builder = reqwest::Client::builder()
            .redirect(policy)
            .cookie_provider(self.1.clone())
            .tls_danger_accept_invalid_certs(insecure)
            .user_agent(concat!("Forge/", env!("CARGO_PKG_VERSION")));
        if let Some(c) = cert {
            let mut pem = read_pem(&c.cert, "certificate")?;
            pem.push(b'\n');
            pem.extend(read_pem(&c.key, "private key")?);
            let identity = reqwest::Identity::from_pem(&pem).map_err(|e| {
                format!("Couldn't load the client certificate: {e}. Use PEM files with an unencrypted key (openssl pkcs12 -in cert.p12 -nodes can convert a .p12).")
            })?;
            builder = builder.identity(identity);
            if let Some(ca) = c.ca.as_deref().filter(|s| !s.trim().is_empty()) {
                for cert in reqwest::Certificate::from_pem_bundle(&read_pem(ca, "CA certificate")?).map_err(|e| format!("Couldn't load the CA certificate: {e}"))? {
                    builder = builder.add_root_certificate(cert);
                }
            }
        }
        let client = builder.build().map_err(|e| e.to_string())?;
        map.insert(key, client.clone());
        Ok(client)
    }

}

/// In-flight requests, so the UI can cancel them.
#[derive(Default)]
pub struct InFlight(Mutex<HashMap<String, AbortHandle>>);

impl InFlight {
    fn insert(&self, id: &str, h: AbortHandle) {
        self.0.lock().unwrap().insert(id.to_string(), h);
    }
    fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    pub fn cancel(&self, id: &str) -> bool {
        match self.0.lock().unwrap().remove(id) {
            Some(h) => {
                h.abort();
                true
            }
            None => false,
        }
    }
}

pub async fn build(client: &reqwest::Client, req: HttpRequest) -> Result<reqwest::RequestBuilder, String> {
    let method = reqwest::Method::from_bytes(req.method.trim().to_uppercase().as_bytes())
        .map_err(|_| format!("Invalid method: {}", req.method))?;
    let mut rb = client.request(method, req.url.trim());
    for h in req.headers.iter().filter(|h| h.enabled && !h.key.trim().is_empty()) {
        rb = rb.header(h.key.trim(), h.value.as_str());
    }
    if let Some(ms) = req.timeout_ms.filter(|ms| *ms > 0) {
        rb = rb.timeout(Duration::from_millis(ms));
    }
    rb = match req.body.unwrap_or(Body::None) {
        Body::None => rb,
        Body::Raw { content } => rb.body(content),
        Body::Form { fields } => {
            let pairs: Vec<(String, String)> = fields
                .into_iter()
                .filter(|f| f.enabled && !f.key.is_empty())
                .map(|f| (f.key, f.value))
                .collect();
            rb.form(&pairs)
        }
        Body::Multipart { fields } => {
            let mut form = reqwest::multipart::Form::new();
            for f in fields.into_iter().filter(|f| f.enabled && !f.key.is_empty()) {
                form = if f.file {
                    form.file(f.key, &f.value).await.map_err(|e| format!("{}: {e}", f.value))?
                } else {
                    form.text(f.key, f.value)
                };
            }
            rb.multipart(form)
        }
        Body::Binary { path } => {
            let bytes = tokio::fs::read(&path).await.map_err(|e| format!("{path}: {e}"))?;
            rb.body(bytes)
        }
    };
    Ok(rb)
}

fn headers_of(res: &reqwest::Response) -> Vec<Kv> {
    res.headers()
        .iter()
        .map(|(k, v)| Kv {
            key: k.to_string(),
            value: String::from_utf8_lossy(v.as_bytes()).into_owned(),
            enabled: true,
        })
        .collect()
}

fn describe(e: reqwest::Error) -> String {
    use std::error::Error;
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(&format!(": {s}"));
        src = s.source();
    }
    msg
}

pub async fn execute(client: reqwest::Client, req: HttpRequest) -> Result<HttpResponse, String> {
    let rb = build(&client, req).await?;
    let start = Instant::now();
    let res = rb.send().await.map_err(describe)?;
    let ttfb = start.elapsed();
    let status = res.status();
    let http_version = format!("{:?}", res.version());
    let url = res.url().to_string();
    let headers = headers_of(&res);
    let bytes = res.bytes().await.map_err(describe)?;
    let total = start.elapsed();
    let (body, body_base64) = match std::str::from_utf8(&bytes) {
        Ok(s) => (s.to_string(), false),
        Err(_) => (base64::engine::general_purpose::STANDARD.encode(&bytes), true),
    };
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        http_version,
        url,
        headers,
        body,
        body_base64,
        size: bytes.len(),
        time_ms: total.as_secs_f64() * 1000.0,
        ttfb_ms: ttfb.as_secs_f64() * 1000.0,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StreamEvent {
    Head { stream_id: String, status: u16, headers: Vec<Kv>, ttfb_ms: f64 },
    Chunk { stream_id: String, data: String },
    End { stream_id: String, time_ms: f64 },
    Error { stream_id: String, message: String },
}

#[tauri::command]
pub async fn http_send(
    id: String,
    request: HttpRequest,
    clients: tauri::State<'_, Clients>,
    inflight: tauri::State<'_, InFlight>,
) -> Result<HttpResponse, String> {
    let client = clients.get_with(request.follow_redirects, request.insecure, request.client_cert.as_ref())?;
    let task = tokio::spawn(execute(client, request));
    inflight.insert(&id, task.abort_handle());
    let out = task.await;
    inflight.remove(&id);
    match out {
        Ok(r) => r,
        Err(e) if e.is_cancelled() => Err("Request cancelled".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Streams the response body as `http-stream` events (used for SSE, A2A streaming, LLM streams).
#[tauri::command]
pub async fn http_stream(
    app: AppHandle,
    id: String,
    request: HttpRequest,
    clients: tauri::State<'_, Clients>,
    inflight: tauri::State<'_, InFlight>,
) -> Result<(), String> {
    let client = clients.get_with(request.follow_redirects, request.insecure, request.client_cert.as_ref())?;
    let rb = build(&client, request).await?;
    let sid = id.clone();
    let emit_app = app.clone();
    let task = tokio::spawn(async move {
        let emit = |ev: StreamEvent| {
            let _ = emit_app.emit("http-stream", ev);
        };
        let start = Instant::now();
        let res = match rb.send().await {
            Ok(r) => r,
            Err(e) => return emit(StreamEvent::Error { stream_id: sid, message: describe(e) }),
        };
        emit(StreamEvent::Head {
            stream_id: sid.clone(),
            status: res.status().as_u16(),
            headers: headers_of(&res),
            ttfb_ms: start.elapsed().as_secs_f64() * 1000.0,
        });
        let mut body = res.bytes_stream();
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(b) => emit(StreamEvent::Chunk {
                    stream_id: sid.clone(),
                    data: String::from_utf8_lossy(&b).into_owned(),
                }),
                Err(e) => return emit(StreamEvent::Error { stream_id: sid, message: describe(e) }),
            }
        }
        emit(StreamEvent::End { stream_id: sid, time_ms: start.elapsed().as_secs_f64() * 1000.0 });
    });
    inflight.insert(&id, task.abort_handle());
    let _ = task.await;
    inflight.remove(&id);
    Ok(())
}

#[tauri::command]
pub fn http_cancel(id: String, inflight: tauri::State<'_, InFlight>) -> bool {
    inflight.cancel(&id)
}

/// Empties the shared cookie jar.
#[tauri::command]
pub fn http_reset_cookies(clients: tauri::State<'_, Clients>) {
    clients.jar().0.write().unwrap().clear();
}
