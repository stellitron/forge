//! Website radar: launches a Chrome-family browser with its own profile and DevTools enabled,
//! and bridges the DevTools protocol to the UI so the API calls a web app makes can be captured
//! while the user (or the agent) browses it. The capture logic lives in TypeScript; this side
//! only launches the browser, relays commands and forwards the events that matter.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(not(unix))]
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
#[cfg(not(unix))]
use tokio_tungstenite::tungstenite::Message;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Session {
    tx: mpsc::UnboundedSender<String>,
    pending: Pending,
    next: AtomicU64,
    child: Child,
    /// Tells this launch apart from a later one under the same radar id.
    token: String,
}

#[derive(Default)]
pub struct RadarManager(Mutex<HashMap<String, Arc<tokio::sync::Mutex<Session>>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RadarEvent {
    radar_id: String,
    method: String,
    params: Value,
    session_id: Option<String>,
}

#[derive(Serialize)]
pub struct Browser {
    name: String,
    path: String,
}

/// Resource types that never carry API traffic; dropped here so the UI isn't flooded.
const STATIC_TYPES: &[&str] = &["Image", "Stylesheet", "Font", "Media", "Script", "Manifest", "TextTrack", "SignedExchange"];

const FORWARDED: &[&str] = &[
    "Network.requestWillBeSent",
    "Network.requestWillBeSentExtraInfo",
    "Network.responseReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Network.webSocketCreated",
    "Fetch.requestPaused",
    "Target.attachedToTarget",
    "Target.detachedFromTarget",
    "Target.targetInfoChanged",
    "Page.frameNavigated",
];

fn forward(method: &str, params: &Value) -> bool {
    if !FORWARDED.contains(&method) {
        return false;
    }
    match params.get("type").and_then(Value::as_str) {
        Some(t) if method == "Network.requestWillBeSent" || method == "Network.responseReceived" => !STATIC_TYPES.contains(&t),
        _ => true,
    }
}

fn candidates() -> Vec<(&'static str, PathBuf)> {
    let mut out: Vec<(&'static str, PathBuf)> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let apps = [
            ("Google Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"),
            ("Microsoft Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            ("Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"),
            ("Chromium", "Chromium.app/Contents/MacOS/Chromium"),
            ("Vivaldi", "Vivaldi.app/Contents/MacOS/Vivaldi"),
            ("Chrome Canary", "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
        ];
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
        for (name, rel) in apps {
            for r in &roots {
                out.push((name, r.join(rel)));
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let rels = [
            ("Google Chrome", r"Google\Chrome\Application\chrome.exe"),
            ("Microsoft Edge", r"Microsoft\Edge\Application\msedge.exe"),
            ("Brave", r"BraveSoftware\Brave-Browser\Application\brave.exe"),
            ("Vivaldi", r"Vivaldi\Application\vivaldi.exe"),
        ];
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(var) {
                for (name, rel) in rels {
                    out.push((name, PathBuf::from(&root).join(rel)));
                }
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let bins = [
            ("Google Chrome", "google-chrome"),
            ("Google Chrome", "google-chrome-stable"),
            ("Chromium", "chromium"),
            ("Chromium", "chromium-browser"),
            ("Microsoft Edge", "microsoft-edge"),
            ("Brave", "brave-browser"),
        ];
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                for (name, bin) in bins {
                    out.push((name, dir.join(bin)));
                }
            }
        }
    }
    out
}

/// Installed Chrome-family browsers, first one found per name.
#[tauri::command]
pub fn radar_browsers() -> Vec<Browser> {
    let mut out: Vec<Browser> = Vec::new();
    for (name, path) in candidates() {
        if path.is_file() && !out.iter().any(|b| b.name == name) {
            out.push(Browser { name: name.into(), path: path.to_string_lossy().into() });
        }
    }
    out
}

fn profile_dir(app: &AppHandle, browser: &Path) -> Result<PathBuf, String> {
    // One profile per browser: their profile formats aren't interchangeable.
    let stem = browser.file_stem().map(|s| s.to_string_lossy().to_lowercase().replace(' ', "-")).unwrap_or_else(|| "browser".into());
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("radar").join(stem);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn emit(app: &AppHandle, radar_id: &str, method: &str, params: Value, session_id: Option<String>) {
    let _ = app.emit("radar-event", RadarEvent { radar_id: radar_id.into(), method: method.into(), params, session_id });
}

/// Handles one DevTools message from the browser: a reply to a pending command, or an event.
fn dispatch(app: &AppHandle, radar_id: &str, pending: &Pending, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return };
    if let Some(n) = v.get("id").and_then(Value::as_u64) {
        if let Some(done) = pending.lock().unwrap().remove(&n) {
            let r = match v.get("error") {
                Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("DevTools error").to_string()),
                None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = done.send(r);
        }
    } else if let Some(method) = v.get("method").and_then(Value::as_str) {
        let params = v.get("params").cloned().unwrap_or(Value::Null);
        if forward(method, &params) {
            let sid = v.get("sessionId").and_then(Value::as_str).map(String::from);
            emit(app, radar_id, method, params, sid);
        }
    }
}

/// The connection ended (browser closed or crashed): forget the session unless a newer one replaced it.
fn closed(app: &AppHandle, radar_id: &str, token: &str, pending: &Pending) {
    pending.lock().unwrap().clear();
    let manager = app.state::<RadarManager>();
    let mut map = manager.0.lock().unwrap();
    let same = map.get(radar_id).is_some_and(|s| s.try_lock().map(|s| s.token == token).unwrap_or(true));
    if same {
        map.remove(radar_id);
    }
    drop(map);
    emit(app, radar_id, "Radar.closed", Value::Null, None);
}

fn base_command(path: &Path, profile: &Path) -> Command {
    let mut cmd = Command::new(path);
    cmd.arg(format!("--user-data-dir={}", profile.display()))
        .args(["--no-first-run", "--no-default-browser-check", "--new-window", "about:blank"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    cmd
}

/// Spawns `cmd` with `--remote-debugging-pipe`: the browser reads commands from fd 3 and writes
/// replies to fd 4. Returns the child, the command writer and the reply reader.
#[cfg(unix)]
fn spawn_piped(mut cmd: Command) -> std::io::Result<(Child, std::io::PipeWriter, std::io::PipeReader)> {
    use std::os::fd::AsRawFd;

    let (cmd_read, cmd_write) = std::io::pipe()?;
    let (res_read, res_write) = std::io::pipe()?;
    let (child_in, child_out) = (cmd_read.as_raw_fd(), res_write.as_raw_fd());
    cmd.arg("--remote-debugging-pipe");
    // SAFETY: only async-signal-safe calls (fcntl, dup2) run between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            // Move both ends above 4 first so placing one can't clobber the other, then onto 3 and 4
            // (dup2 clears close-on-exec, so the browser inherits them).
            let a = libc::fcntl(child_in, libc::F_DUPFD, 10);
            let b = libc::fcntl(child_out, libc::F_DUPFD, 10);
            if a < 0 || b < 0 || libc::dup2(a, 3) < 0 || libc::dup2(b, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    // The browser holds its own copies; ours must close so reads end when it exits.
    drop(cmd_read);
    drop(res_write);
    Ok((child, cmd_write, res_read))
}

/// Launches the browser with DevTools over a private pipe (fds 3 and 4), so no other program on
/// the machine can connect to it: unlike a debugging port, nothing listens on the network.
#[cfg(unix)]
async fn launch(app: &AppHandle, radar_id: &str, token: &str, path: &Path, profile: &Path, pending: &Pending) -> Result<(Child, mpsc::UnboundedSender<String>), String> {
    use std::io::{BufRead, BufReader, Write};

    let (child, mut cmd_write, res_read) = spawn_piped(base_command(path, profile)).map_err(|e| format!("Could not start {}: {e}", path.display()))?;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        while let Some(text) = rx.blocking_recv() {
            if cmd_write.write_all(text.as_bytes()).and_then(|_| cmd_write.write_all(b"\0")).is_err() {
                break;
            }
        }
    });
    let (app, radar_id, token, pending) = (app.clone(), radar_id.to_string(), token.to_string(), pending.clone());
    std::thread::spawn(move || {
        let mut reader = BufReader::new(res_read);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(0, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if buf.last() == Some(&0) {
                        buf.pop();
                    }
                    dispatch(&app, &radar_id, &pending, &String::from_utf8_lossy(&buf));
                }
            }
        }
        closed(&app, &radar_id, &token, &pending);
    });
    Ok((child, tx))
}

/// Windows can't hand the browser extra pipe handles from here, so DevTools listens on a random
/// loopback port for as long as the radar browser is open.
#[cfg(not(unix))]
async fn launch(app: &AppHandle, radar_id: &str, token: &str, path: &Path, profile: &Path, pending: &Pending) -> Result<(Child, mpsc::UnboundedSender<String>), String> {
    let port_file = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);
    let mut cmd = base_command(path, profile);
    cmd.arg("--remote-debugging-port=0");
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", path.display()))?;
    // The browser writes its port and browser-target path once DevTools is listening.
    let mut ws_url = None;
    for _ in 0..150 {
        if let Ok(s) = std::fs::read_to_string(&port_file) {
            let mut lines = s.lines();
            if let (Some(port), Some(p)) = (lines.next(), lines.next()) {
                ws_url = Some(format!("ws://127.0.0.1:{}{}", port.trim(), p.trim()));
                break;
            }
        }
        if let Ok(Some(_)) = child.try_wait() {
            // It handed the launch to a browser already running on this profile, or crashed.
            return Err(format!("{} closed right after starting. If a radar browser window is still open, close it and try again.", browser_name(path)));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let Some(ws_url) = ws_url else {
        let _ = child.kill().await;
        return Err(no_devtools(path));
    };
    let (stream, _) = match tokio_tungstenite::connect_async(ws_url.as_str()).await {
        Ok(s) => s,
        Err(e) => {
            let _ = child.kill().await;
            return Err(format!("Couldn't connect to {}'s DevTools on this computer ({e}). Security software may be blocking local connections.", browser_name(path)));
        }
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let (app, radar_id, token, pending) = (app.clone(), radar_id.to_string(), token.to_string(), pending.clone());
    tokio::spawn(async move {
        let (mut sink, mut source) = stream.split();
        tokio::spawn(async move {
            while let Some(text) = rx.recv().await {
                if sink.send(Message::text(text)).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        while let Some(Ok(msg)) = source.next().await {
            if let Message::Text(t) = msg {
                dispatch(&app, &radar_id, &pending, &t);
            }
        }
        closed(&app, &radar_id, &token, &pending);
    });
    Ok((child, tx))
}

fn browser_name(path: &Path) -> String {
    radar_browsers().into_iter().find(|b| Path::new(&b.path) == path).map(|b| b.name).unwrap_or_else(|| "The browser".into())
}

/// Why DevTools never came up: usually an organization policy that turns it off.
fn no_devtools(path: &Path) -> String {
    let name = browser_name(path);
    match blocking_policy(path) {
        Some(policy) => format!("{name} is managed by your organization, and its {policy} policy turns off the DevTools connection the radar needs. Pick another browser above, or ask your IT team to allow remote debugging."),
        None => format!("{name} started but never opened its DevTools connection. If your organization manages this browser, it may have remote debugging turned off; try another browser above."),
    }
}

/// Browser policy locations: (program file stem, Windows registry key, macOS preference domain).
const POLICY_HOMES: &[(&str, &str, &str)] = &[
    ("chrome", r"SOFTWARE\Policies\Google\Chrome", "com.google.Chrome"),
    ("google chrome", r"SOFTWARE\Policies\Google\Chrome", "com.google.Chrome"),
    ("msedge", r"SOFTWARE\Policies\Microsoft\Edge", "com.microsoft.Edge"),
    ("microsoft edge", r"SOFTWARE\Policies\Microsoft\Edge", "com.microsoft.Edge"),
    ("brave", r"SOFTWARE\Policies\BraveSoftware\Brave", "com.brave.Browser"),
    ("brave browser", r"SOFTWARE\Policies\BraveSoftware\Brave", "com.brave.Browser"),
    ("chromium", r"SOFTWARE\Policies\Chromium", "org.chromium.Chromium"),
];

/// The name of a policy set on this browser that blocks DevTools, if any.
fn blocking_policy(path: &Path) -> Option<&'static str> {
    let stem = path.file_stem()?.to_string_lossy().to_lowercase();
    let &(_, _key, _domain) = POLICY_HOMES.iter().find(|(s, _, _)| *s == stem)?;
    let read = |name: &str| -> Option<i64> {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            for hive in ["HKLM", "HKCU"] {
                let out = std::process::Command::new("reg").args(["query", &format!(r"{hive}\{_key}"), "/v", name]).creation_flags(0x0800_0000).output().ok()?;
                if let Some(v) = parse_reg_dword(&String::from_utf8_lossy(&out.stdout), name) {
                    return Some(v);
                }
            }
            None
        }
        #[cfg(target_os = "macos")]
        {
            let out = std::process::Command::new("defaults").args(["read", &format!("/Library/Managed Preferences/{_domain}"), name]).output().ok()?;
            String::from_utf8_lossy(&out.stdout).trim().parse().ok()
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = name;
            None
        }
    };
    if read("RemoteDebuggingAllowed") == Some(0) {
        Some("RemoteDebuggingAllowed")
    } else if read("DeveloperToolsAvailability") == Some(2) {
        Some("DeveloperToolsAvailability")
    } else {
        None
    }
}

/// Reads `name    REG_DWORD    0x0` from `reg query` output.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_reg_dword(out: &str, name: &str) -> Option<i64> {
    let line = out.lines().find(|l| l.split_whitespace().next() == Some(name))?;
    let v = line.split_whitespace().nth(2)?;
    i64::from_str_radix(v.trim_start_matches("0x"), 16).ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    browser: String,
    /// True when DevTools runs over a private pipe rather than a loopback port.
    private: bool,
}

/// A radar browser left running (Forge crashed, or an older version didn't close it) owns the
/// profile, and a new launch would just hand itself over to it and exit. Close that one first.
/// Only a process whose command line names this exact profile is touched.
#[cfg(unix)]
async fn close_stale(profile: &Path) {
    // Chrome's SingletonLock is a symlink to "<hostname>-<pid>".
    let Ok(target) = std::fs::read_link(profile.join("SingletonLock")) else { return };
    let Some(pid) = target.to_string_lossy().rsplit('-').next().and_then(|p| p.parse::<i32>().ok()) else { return };
    let Ok(out) = std::process::Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output() else { return };
    if !String::from_utf8_lossy(&out.stdout).contains(&format!("--user-data-dir={}", profile.display())) {
        return;
    }
    // SAFETY: plain signal calls on a pid we just matched to our own radar browser.
    unsafe { libc::kill(pid, libc::SIGTERM) };
    for _ in 0..60 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if unsafe { libc::kill(pid, 0) } == 0 {
        unsafe { libc::kill(pid, libc::SIGKILL) };
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Windows version: Chrome keeps a `lockfile` in the profile while it runs. Find the process whose
/// command line names this exact profile and end it.
#[cfg(target_os = "windows")]
async fn close_stale(path: &Path, profile: &Path) {
    let lock = profile.join("lockfile");
    if !lock.exists() || std::fs::remove_file(&lock).is_ok() {
        // No lock, or nobody holds it: no browser is running on this profile.
        return;
    }
    let Some(exe) = path.file_name().map(|n| n.to_string_lossy().replace('\'', "''")) else { return };
    let needle = format!("--user-data-dir={}", profile.display()).replace('\'', "''");
    let script = format!("Get-CimInstance Win32_Process -Filter \"Name='{exe}'\" | Where-Object {{ $_.CommandLine -and $_.CommandLine.Contains('{needle}') }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}");
    let _ = tokio::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).creation_flags(0x0800_0000).output().await;
    for _ in 0..30 {
        if std::fs::remove_file(&lock).is_ok() || !lock.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Opens a blank tab in a separate browser instance and connects to its DevTools.
#[tauri::command]
pub async fn radar_start(
    app: AppHandle,
    id: String,
    browser: Option<String>,
    manager: tauri::State<'_, RadarManager>,
) -> Result<Started, String> {
    stop(&manager, &id).await;
    let path = match browser.filter(|b| !b.is_empty()) {
        Some(b) => PathBuf::from(b),
        None => radar_browsers().first().map(|b| PathBuf::from(&b.path)).ok_or("No Chrome, Edge, Brave or Chromium found. Install one, or pick the browser's program file.")?,
    };
    let profile = profile_dir(&app, &path)?;
    #[cfg(unix)]
    close_stale(&profile).await;
    #[cfg(target_os = "windows")]
    close_stale(&path, &profile).await;
    let token = uuid::Uuid::new_v4().to_string();
    let pending: Pending = Arc::default();
    let (child, tx) = launch(&app, &id, &token, &path, &profile, &pending).await?;
    let session = Session { tx, pending, next: AtomicU64::new(1), child, token };
    manager.0.lock().unwrap().insert(id.clone(), Arc::new(tokio::sync::Mutex::new(session)));
    // A browser already running with this profile takes the launch over and exits, so check we
    // really reached a DevTools endpoint before reporting success.
    if send(&manager, &id, "Browser.getVersion", None, None, Duration::from_secs(20)).await.is_err() {
        stop(&manager, &id).await;
        return Err(if cfg!(unix) { no_devtools(&path) } else { format!("{} opened DevTools but didn't answer. Close any radar browser window and try again.", browser_name(&path)) });
    }
    Ok(Started { browser: path.to_string_lossy().into(), private: cfg!(unix) })
}

async fn send(manager: &RadarManager, id: &str, method: &str, params: Option<Value>, session_id: Option<String>, timeout: Duration) -> Result<Value, String> {
    let session = manager.0.lock().unwrap().get(id).cloned().ok_or("The radar browser isn't running")?;
    let rx = {
        let s = session.lock().await;
        let n = s.next.fetch_add(1, Ordering::Relaxed);
        let mut msg = json!({ "id": n, "method": method, "params": params.unwrap_or_else(|| json!({})) });
        if let Some(sid) = session_id {
            msg["sessionId"] = json!(sid);
        }
        let (done, rx) = oneshot::channel();
        s.pending.lock().unwrap().insert(n, done);
        s.tx.send(msg.to_string()).map_err(|_| "The radar browser closed")?;
        rx
    };
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("The radar browser closed".into()),
        Err(_) => Err(format!("{method} timed out")),
    }
}

/// Sends one DevTools command (to a target when `session_id` is set) and returns its result.
#[tauri::command]
pub async fn radar_send(
    id: String,
    method: String,
    params: Option<Value>,
    session_id: Option<String>,
    manager: tauri::State<'_, RadarManager>,
) -> Result<Value, String> {
    send(&manager, &id, &method, params, session_id, Duration::from_secs(30)).await
}

async fn stop(manager: &RadarManager, id: &str) {
    let s = manager.0.lock().unwrap().remove(id);
    if let Some(s) = s {
        let mut s = s.lock().await;
        let n = s.next.fetch_add(1, Ordering::Relaxed);
        let _ = s.tx.send(json!({ "id": n, "method": "Browser.close" }).to_string());
        if tokio::time::timeout(Duration::from_secs(3), s.child.wait()).await.is_err() {
            let _ = s.child.kill().await;
        }
    }
}

/// Closes every radar browser when Forge quits, so none is left running with a live DevTools connection.
pub fn shutdown(app: &AppHandle) {
    let sessions: Vec<_> = app.state::<RadarManager>().0.lock().unwrap().drain().map(|(_, s)| s).collect();
    for s in &sessions {
        if let Ok(s) = s.try_lock() {
            let _ = s.tx.send(json!({ "id": 0, "method": "Browser.close" }).to_string());
        }
    }
    if !sessions.is_empty() {
        std::thread::sleep(Duration::from_millis(400));
    }
    for s in sessions {
        if let Ok(mut s) = s.try_lock() {
            let _ = s.child.start_kill();
        }
    }
}

#[tauri::command]
pub async fn radar_stop(id: String, manager: tauri::State<'_, RadarManager>) -> Result<(), String> {
    stop(&manager, &id).await;
    Ok(())
}

/// Deletes the radar browser profiles, signing out of every site logged into through the radar.
#[tauri::command]
pub fn radar_clear_profiles(app: AppHandle, manager: tauri::State<'_, RadarManager>) -> Result<(), String> {
    if !manager.0.lock().unwrap().is_empty() {
        return Err("Close the radar browser first".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("radar");
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_policy_values_from_reg_output() {
        let out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome\r\n    RemoteDebuggingAllowed    REG_DWORD    0x0\r\n\r\n";
        assert_eq!(parse_reg_dword(out, "RemoteDebuggingAllowed"), Some(0));
        assert_eq!(parse_reg_dword("    DeveloperToolsAvailability    REG_DWORD    0x2", "DeveloperToolsAvailability"), Some(2));
        assert_eq!(parse_reg_dword("ERROR: The system was unable to find the specified registry key or value.", "RemoteDebuggingAllowed"), None);
    }

    #[test]
    fn forwards_api_traffic_only() {
        assert!(forward("Network.requestWillBeSent", &json!({ "type": "Fetch" })));
        assert!(forward("Network.requestWillBeSent", &json!({ "type": "XHR" })));
        assert!(!forward("Network.requestWillBeSent", &json!({ "type": "Image" })));
        assert!(!forward("Network.responseReceived", &json!({ "type": "Stylesheet" })));
        assert!(forward("Network.loadingFinished", &json!({})));
        assert!(!forward("Network.dataReceived", &json!({})));
        assert!(!forward("Runtime.consoleAPICalled", &json!({})));
    }

    /// Talks to a real browser over the private pipe. Needs Chrome, Edge, Brave or Chromium:
    /// `cargo test radar -- --ignored`.
    #[cfg(unix)]
    #[tokio::test]
    #[ignore]
    async fn pipe_reaches_devtools_without_a_port() {
        use std::io::{BufRead, BufReader, Write};
        let Some(b) = radar_browsers().into_iter().next() else { return };
        let profile = std::env::temp_dir().join(format!("forge-radar-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&profile).unwrap();
        let mut cmd = base_command(Path::new(&b.path), &profile);
        cmd.arg("--headless=new");
        let (mut child, mut w, r) = spawn_piped(cmd).unwrap();
        w.write_all(br#"{"id":1,"method":"Browser.getVersion"}"#).unwrap();
        w.write_all(b"\0").unwrap();
        let reply = tokio::task::spawn_blocking(move || {
            let mut buf = Vec::new();
            BufReader::new(r).read_until(0, &mut buf).unwrap();
            buf.pop();
            serde_json::from_slice::<Value>(&buf).unwrap()
        });
        let v = tokio::time::timeout(Duration::from_secs(20), reply).await.unwrap().unwrap();
        assert_eq!(v["id"], 1);
        assert!(v["result"]["product"].as_str().unwrap_or("").contains('/'));
        // No DevTools port was opened.
        assert!(!profile.join("DevToolsActivePort").exists());
        let _ = child.kill().await;
        let _ = std::fs::remove_dir_all(&profile);
    }

    /// A leftover browser on the profile is closed so a fresh launch can take it over.
    #[cfg(unix)]
    #[tokio::test]
    #[ignore]
    async fn closes_a_leftover_radar_browser() {
        let Some(b) = radar_browsers().into_iter().next() else { return };
        let profile = std::env::temp_dir().join(format!("forge-radar-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&profile).unwrap();
        let mut old = base_command(Path::new(&b.path), &profile);
        old.args(["--headless=new", "--remote-debugging-port=0"]);
        let mut old = old.spawn().unwrap();
        for _ in 0..100 {
            if profile.join("SingletonLock").symlink_metadata().is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(profile.join("SingletonLock").symlink_metadata().is_ok());
        close_stale(&profile).await;
        let exited = tokio::time::timeout(Duration::from_secs(5), old.wait()).await;
        assert!(exited.is_ok(), "the leftover browser should have exited");
        // An unrelated profile path never matches.
        close_stale(&std::env::temp_dir().join("forge-radar-none")).await;
        let _ = std::fs::remove_dir_all(&profile);
    }
}
