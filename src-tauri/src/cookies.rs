//! One cookie jar for every HTTP client (clients differ by redirect, TLS and certificate
//! settings, and each used to keep its own cookies), with commands to see and edit it. The UI
//! swaps the jar's contents per environment and keeps it in app data, never in the workspace.

use std::sync::RwLock;

use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};

#[derive(Default)]
pub struct Jar(pub RwLock<cookie_store::CookieStore>);

impl reqwest::cookie::CookieStore for Jar {
    fn set_cookies(&self, cookie_headers: &mut dyn Iterator<Item = &HeaderValue>, url: &url::Url) {
        let cookies: Vec<_> = cookie_headers.filter_map(|v| v.to_str().ok()).filter_map(|s| cookie::Cookie::parse(s.to_owned()).ok()).collect();
        self.0.write().unwrap().store_response_cookies(cookies.into_iter(), url);
    }

    fn cookies(&self, url: &url::Url) -> Option<HeaderValue> {
        let store = self.0.read().unwrap();
        let header = store.get_request_values(url).map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ");
        if header.is_empty() { None } else { HeaderValue::from_str(&header).ok() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CookieView {
    pub name: String,
    pub value: String,
    /// The host it's for (host-only) or the domain it covers, without a leading dot.
    pub domain: String,
    pub path: String,
    /// Unix seconds; none for a session cookie.
    pub expires: Option<i64>,
    pub secure: bool,
    pub http_only: bool,
    /// Sent only to `domain` itself, not its subdomains.
    pub host_only: bool,
}

pub fn list(jar: &Jar) -> Vec<CookieView> {
    let store = jar.0.read().unwrap();
    let mut out: Vec<CookieView> = store
        .iter_unexpired()
        .map(|c| {
            let (domain, host_only) = match &c.domain {
                cookie_store::CookieDomain::HostOnly(d) => (d.clone(), true),
                cookie_store::CookieDomain::Suffix(d) => (d.clone(), false),
                _ => (String::new(), true),
            };
            let expires = match &c.expires {
                cookie_store::CookieExpiration::AtUtc(t) => Some(t.unix_timestamp()),
                cookie_store::CookieExpiration::SessionEnd => None,
            };
            CookieView { name: c.name().into(), value: c.value().into(), domain, path: String::from(c.path.clone()), expires, secure: c.secure().unwrap_or(false), http_only: c.http_only().unwrap_or(false), host_only }
        })
        .collect();
    out.sort_by(|a, b| (a.domain.as_str(), a.path.as_str(), a.name.as_str()).cmp(&(b.domain.as_str(), b.path.as_str(), b.name.as_str())));
    out
}

/// Adds or replaces a cookie, as if `domain` had set it.
pub fn set(jar: &Jar, c: &CookieView) -> Result<(), String> {
    let domain = c.domain.trim().trim_start_matches('.').to_ascii_lowercase();
    if domain.is_empty() || c.name.trim().is_empty() {
        return Err("A cookie needs a name and a domain".into());
    }
    let path = if c.path.starts_with('/') { c.path.clone() } else { "/".into() };
    let url = url::Url::parse(&format!("{}://{domain}{path}", if c.secure { "https" } else { "http" })).map_err(|e| format!("Invalid domain: {e}"))?;
    let mut raw = cookie::Cookie::new(c.name.trim().to_owned(), c.value.clone());
    raw.set_path(path);
    if !c.host_only {
        raw.set_domain(domain.clone());
    }
    raw.set_secure(c.secure);
    raw.set_http_only(c.http_only);
    if let Some(t) = c.expires.and_then(|s| time::OffsetDateTime::from_unix_timestamp(s).ok()) {
        raw.set_expires(t);
    }
    jar.0.write().unwrap().insert_raw(&raw, &url).map(|_| ()).map_err(|e| e.to_string())
}

pub fn remove(jar: &Jar, domain: &str, path: &str, name: &str) {
    jar.0.write().unwrap().remove(domain, path, name);
}

/// Everything in the jar, session cookies included, for saving per environment.
pub fn export(jar: &Jar) -> Result<String, String> {
    let mut buf = Vec::new();
    cookie_store::serde::json::save_incl_expired_and_nonpersistent(&jar.0.read().unwrap(), &mut buf).map_err(|e| e.to_string())?;
    String::from_utf8(buf).map_err(|e| e.to_string())
}

/// Replaces the jar's contents (expired cookies are dropped).
pub fn import(jar: &Jar, text: &str) -> Result<(), String> {
    let store = if text.trim().is_empty() { cookie_store::CookieStore::default() } else { cookie_store::serde::json::load(text.as_bytes()).map_err(|e| e.to_string())? };
    *jar.0.write().unwrap() = store;
    Ok(())
}

#[tauri::command]
pub fn cookies_list(clients: tauri::State<'_, crate::http::Clients>) -> Vec<CookieView> {
    list(&clients.jar())
}

#[tauri::command]
pub fn cookies_set(cookie: CookieView, clients: tauri::State<'_, crate::http::Clients>) -> Result<(), String> {
    set(&clients.jar(), &cookie)
}

#[tauri::command]
pub fn cookies_delete(domain: String, path: String, name: String, clients: tauri::State<'_, crate::http::Clients>) {
    remove(&clients.jar(), &domain, &path, &name)
}

#[tauri::command]
pub fn cookies_export(clients: tauri::State<'_, crate::http::Clients>) -> Result<String, String> {
    export(&clients.jar())
}

#[tauri::command]
pub fn cookies_import(text: String, clients: tauri::State<'_, crate::http::Clients>) -> Result<(), String> {
    import(&clients.jar(), &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::cookie::CookieStore as _;

    fn url(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn stores_and_sends_cookies_like_a_browser() {
        let jar = Jar::default();
        let hv = [HeaderValue::from_static("sid=abc; Path=/; HttpOnly"), HeaderValue::from_static("pref=dark; Domain=shop.test; Path=/")];
        jar.set_cookies(&mut hv.iter(), &url("https://api.shop.test/login"));
        // The jar's order isn't fixed (servers don't care), so compare the set.
        let sent = jar.cookies(&url("https://api.shop.test/orders")).unwrap();
        let mut parts: Vec<&str> = sent.to_str().unwrap().split("; ").collect();
        parts.sort();
        assert_eq!(parts, ["pref=dark", "sid=abc"]);
        // Host-only sid stays on api.shop.test; the domain cookie covers subdomains.
        assert_eq!(jar.cookies(&url("https://www.shop.test/")).unwrap(), "pref=dark");
        assert!(jar.cookies(&url("https://other.test/")).is_none());
        let l = list(&jar);
        assert_eq!(l.iter().map(|c| (c.name.as_str(), c.domain.as_str(), c.host_only, c.http_only)).collect::<Vec<_>>(), vec![("sid", "api.shop.test", true, true), ("pref", "shop.test", false, false)]);
    }

    #[test]
    fn edits_and_round_trips_including_session_cookies() {
        let jar = Jar::default();
        set(&jar, &CookieView { name: "token".into(), value: "t1".into(), domain: "api.test".into(), path: "/".into(), expires: None, secure: true, http_only: true, host_only: true }).unwrap();
        set(&jar, &CookieView { name: "token".into(), value: "t2".into(), domain: "api.test".into(), path: "/".into(), expires: None, secure: true, http_only: true, host_only: true }).unwrap();
        assert_eq!(jar.cookies(&url("https://api.test/x")).unwrap(), "token=t2");
        assert!(jar.cookies(&url("http://api.test/x")).is_none(), "secure cookies stay off plain http");
        let saved = export(&jar).unwrap();
        let other = Jar::default();
        import(&other, &saved).unwrap();
        assert_eq!(list(&other), list(&jar));
        remove(&other, "api.test", "/", "token");
        assert!(list(&other).is_empty());
        import(&other, "").unwrap();
        assert!(set(&jar, &CookieView { name: "".into(), value: "".into(), domain: "x".into(), path: "/".into(), expires: None, secure: false, http_only: false, host_only: true }).is_err());
    }
}
