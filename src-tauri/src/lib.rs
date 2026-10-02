mod authority;
mod screen;

use authority::{AuthResult, Authority, Bootstrap, Challenge, ClipboardCommand, MouseCommand};
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
) -> Result<Challenge, String> {
    authority.begin_auth(peer, host_cert, client_cert)
}

#[tauri::command]
fn finish_auth(
    authority: State<'_, Authority>,
    peer: String,
    client_nonce: String,
    proof: String,
) -> Result<AuthResult, String> {
    authority.finish_auth(peer, client_nonce, proof)
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
    authority.replace_password(&data_dir)
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
