mod authority;
#[cfg(target_os = "linux")]
mod browser_host;
mod screen;

use authority::{AuthResult, Authority, Bootstrap, Challenge, ClipboardCommand, MouseCommand};
use tauri::{Manager, State};

#[tauri::command]
fn transport_mode() -> &'static str {
    if cfg!(target_os = "linux") {
        "external"
    } else {
        "webview"
    }
}

#[tauri::command]
fn open_browser_host(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("unavailable".into());
    }
    #[cfg(target_os = "linux")]
    {
        let host = app.state::<browser_host::BrowserHost>();
        std::process::Command::new("xdg-open")
            .arg(&host.url)
            .spawn()
            .map_err(|_| "browser_open_failed")?;
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Err("unavailable".into())
    }
}

#[tauri::command]
async fn open_controller(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("unavailable".into());
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg("https://georgefejer91.github.io/ninja-desk/")
            .spawn()
            .map_err(|_| "browser_open_failed")?;
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        if let Some(controller) = app.get_webview_window("controller") {
            controller.show().map_err(|_| "window_failed")?;
            controller.set_focus().map_err(|_| "window_failed")?;
            return Ok(());
        }
        tauri::WebviewWindowBuilder::new(
            &app,
            "controller",
            tauri::WebviewUrl::App("controller.html".into()),
        )
        .title("Ninja Desk — Control another PC")
        .inner_size(1100.0, 760.0)
        .min_inner_size(640.0, 420.0)
        .build()
        .map_err(|_| "window_failed")?;
        Ok(())
    }
}

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
fn read_frame(
    authority: State<'_, Authority>,
    frames: State<'_, screen::FrameStore>,
    since: u64,
) -> Option<screen::FrameResult> {
    authority.active_peer()?;
    frames.latest(since)
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
            app.manage(screen::FrameStore::default());
            #[cfg(target_os = "linux")]
            {
                let browser_host =
                    browser_host::start(app.handle().clone()).map_err(std::io::Error::other)?;
                app.manage(browser_host);
            }
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
            read_frame,
            disconnect,
            stop,
            replace_password,
            open_controller,
            open_browser_host,
            transport_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
