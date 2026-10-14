mod http;
mod mcp;
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
        .invoke_handler(tauri::generate_handler![
            http::http_send,
            http::http_stream,
            http::http_cancel,
            http::http_reset_cookies,
            mcp::mcp_connect,
            mcp::mcp_request,
            mcp::mcp_notify,
            mcp::mcp_disconnect,
            ws::ws_connect,
            ws::ws_send,
            ws::ws_close,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
