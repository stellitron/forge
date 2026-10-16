mod cookies;
mod http;
mod mcp;
mod mock;
mod oauth;
mod radar;
mod server;
mod sse;
mod store;
#[cfg(test)]
mod tests;
mod ws;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .manage(http::Clients::default())
        .manage(http::InFlight::default())
        .manage(mcp::McpManager::default())
        .manage(ws::WsManager::default())
        .manage(server::ServerState::default())
        .manage(store::Workspace::default())
        .manage(oauth::OAuthListeners::default())
        .manage(radar::RadarManager::default())
        .manage(mock::MockManager::default())
        .invoke_handler(tauri::generate_handler![
            http::http_send,
            http::http_stream,
            http::http_cancel,
            http::http_reset_cookies,
            cookies::cookies_list,
            cookies::cookies_set,
            cookies::cookies_delete,
            cookies::cookies_export,
            cookies::cookies_import,
            oauth::oauth_listen,
            oauth::oauth_wait,
            oauth::oauth_cancel,
            mcp::mcp_connect,
            mcp::mcp_request,
            mcp::mcp_notify,
            mcp::mcp_disconnect,
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
            mock::mock_start,
            mock::mock_update,
            mock::mock_stop,
            mock::mock_list,
            radar::radar_browsers,
            radar::radar_start,
            radar::radar_send,
            radar::radar_stop,
            radar::radar_clear_profiles,
            store::workspace_open,
            store::import_read,
            store::workspace_write_bytes,
            store::file_save,
            server::server_start,
            server::server_stop,
            server::server_reply,
            store::workspace_write,
            store::workspace_mkdir,
            store::workspace_delete,
            store::workspace_rename,
            store::workspace_ensure_gitignore,
            store::settings_read,
            store::settings_write,
            store::appdata_read,
            store::appdata_write,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                radar::shutdown(app);
            }
        });
}
