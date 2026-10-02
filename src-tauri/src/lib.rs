mod authority;
mod screen;

use authority::{
    AccessLink, AuthResult, Authority, Bootstrap, Challenge, ClipboardCommand, MouseCommand,
};
use tauri::{Manager, State};

#[tauri::command]
fn bootstrap(authority: State<'_, Authority>) -> Result<Bootstrap, String> {
    authority.bootstrap()
}

#[tauri::command]
fn begin_auth(
    authority: State<'_, Authority>,
    peer: String,
    host_cert: String,
    client_cert: String,
    invite_id: Option<String>,
) -> Result<Challenge, String> {
    authority.begin_auth(peer, host_cert, client_cert, invite_id)
}

#[tauri::command]
fn finish_auth(
    authority: State<'_, Authority>,
    peer: String,
    client_nonce: String,
    proof: String,
    invite_id: Option<String>,
) -> Result<AuthResult, String> {
    authority.finish_auth(peer, client_nonce, proof, invite_id)
}

#[tauri::command]
fn create_access_link(authority: State<'_, Authority>) -> Result<AccessLink, String> {
    authority.create_access_link()
}

#[tauri::command]
fn revoke_access_link(authority: State<'_, Authority>, id: String) {
    authority.revoke_access_link(&id);
}

#[tauri::command]
fn access_link_active(authority: State<'_, Authority>, id: String) -> bool {
    authority.access_link_active(&id)
}

#[tauri::command]
fn mouse(authority: State<'_, Authority>, command: MouseCommand) -> Result<(), String> {
    authority.mouse(command)
}

#[tauri::command]
fn write_clipboard(
    authority: State<'_, Authority>,
    command: ClipboardCommand,
) -> Result<(), String> {
    authority.write_clipboard(command)
}

#[tauri::command]
fn read_clipboard(authority: State<'_, Authority>) -> Result<Option<String>, String> {
    authority.read_clipboard()
}

#[tauri::command]
fn active_peer(authority: State<'_, Authority>) -> Option<String> {
    authority.active_peer()
}

#[tauri::command]
fn disconnect(authority: State<'_, Authority>, peer: String) {
    authority.disconnect(&peer);
}

#[tauri::command]
fn stop(authority: State<'_, Authority>) {
    authority.stop();
}

#[tauri::command]
fn replace_password(app: tauri::AppHandle, authority: State<'_, Authority>) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "secret_store_failed")?;
    authority.replace_password(&data_dir)?;
    app.request_restart();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let authority = Authority::load(&data_dir).map_err(std::io::Error::other)?;
            app.manage(authority);
            screen::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            create_access_link,
            revoke_access_link,
            access_link_active,
            begin_auth,
            finish_auth,
            mouse,
            write_clipboard,
            read_clipboard,
            active_peer,
            disconnect,
            stop,
            replace_password
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
