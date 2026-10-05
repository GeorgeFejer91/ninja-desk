mod authority;
#[cfg(target_os = "linux")]
mod browser_host;
mod screen;

use authority::{
    AccessLink, AuthResult, Authority, Bootstrap, Challenge, ClipboardCommand, ControllerTrust,
    MouseCommand, TrustedGrant,
};
use tauri::{Manager, State};
use tauri_plugin_autostart::ManagerExt;

fn require_host(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("unavailable".into())
    }
}

#[tauri::command]
fn transport_mode(window: tauri::WebviewWindow) -> Result<&'static str, String> {
    require_host(&window)?;
    Ok(if cfg!(target_os = "linux") {
        "external"
    } else {
        "webview"
    })
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
fn bootstrap(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
) -> Result<Bootstrap, String> {
    require_host(&window)?;
    authority.bootstrap()
}

#[tauri::command]
fn begin_auth(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
    peer: String,
    host_cert: String,
    client_cert: String,
    invite_id: Option<String>,
    trusted_id: Option<String>,
) -> Result<Challenge, String> {
    require_host(&window)?;
    authority.begin_auth(peer, host_cert, client_cert, invite_id, trusted_id)
}

#[tauri::command]
fn finish_auth(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
    peer: String,
    client_nonce: String,
    proof: String,
    invite_id: Option<String>,
    trusted_id: Option<String>,
) -> Result<AuthResult, String> {
    require_host(&window)?;
    authority.finish_auth(peer, client_nonce, proof, invite_id, trusted_id)
}

#[tauri::command]
fn approve_trusted_pc(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
    peer: String,
) -> Result<TrustedGrant, String> {
    if window.label() != "main" {
        return Err("unavailable".into());
    }
    authority.approve_trusted_pc(&peer)
}

#[tauri::command]
fn revoke_trusted_pc(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("unavailable".into());
    }
    authority.revoke_trusted_pc()
}

#[tauri::command]
fn load_trusted_controller(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<ControllerTrust>, String> {
    if window.label() != "controller" {
        return Err("unavailable".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "secret_store_failed")?;
    authority::load_controller_trust(&data_dir)
}

#[tauri::command]
fn save_trusted_controller(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    trust: ControllerTrust,
) -> Result<(), String> {
    if window.label() != "controller" {
        return Err("unavailable".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "secret_store_failed")?;
    authority::save_controller_trust(&data_dir, &trust)
}

#[tauri::command]
fn forget_trusted_controller(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if window.label() != "controller" {
        return Err("unavailable".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "secret_store_failed")?;
    authority::forget_controller_trust(&data_dir)
}

#[tauri::command]
fn get_start_on_login(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<bool, String> {
    if window.label() != "main" || !cfg!(windows) {
        return Err("unavailable".into());
    }
    app.autolaunch()
        .is_enabled()
        .map_err(|_| "autostart_failed".into())
}

#[tauri::command]
fn set_start_on_login(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    if window.label() != "main" || !cfg!(windows) {
        return Err("unavailable".into());
    }
    let data_dir = app.path().app_data_dir().map_err(|_| "autostart_failed")?;
    std::fs::write(data_dir.join("startup-choice-v1"), b"chosen")
        .map_err(|_| "autostart_failed")?;
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|_| "autostart_failed".into())
}

#[tauri::command]
fn create_access_link(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
) -> Result<AccessLink, String> {
    require_host(&window)?;
    authority.create_access_link()
}

#[tauri::command]
fn revoke_access_link(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
    id: String,
) -> Result<(), String> {
    require_host(&window)?;
    authority.revoke_access_link(&id);
    Ok(())
}

#[tauri::command]
fn access_link_active(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
    id: String,
) -> Result<bool, String> {
    require_host(&window)?;
    Ok(authority.access_link_active(&id))
}

#[tauri::command]
fn mouse(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
    command: MouseCommand,
) -> Result<(), String> {
    require_host(&window)?;
    authority.mouse(command)
}

#[tauri::command]
fn write_clipboard(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
    command: ClipboardCommand,
) -> Result<(), String> {
    require_host(&window)?;
    authority.write_clipboard(command)
}

#[tauri::command]
fn read_clipboard(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
) -> Result<Option<String>, String> {
    require_host(&window)?;
    authority.read_clipboard()
}

#[tauri::command]
fn active_peer(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
) -> Result<Option<String>, String> {
    require_host(&window)?;
    Ok(authority.active_peer())
}

#[tauri::command]
fn read_frame(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
    frames: State<'_, screen::FrameStore>,
    since: u64,
) -> Option<screen::FrameResult> {
    if require_host(&window).is_err() {
        return None;
    }
    authority.active_peer()?;
    frames.latest(since)
}

#[tauri::command]
fn set_screen_capture_paused(
    window: tauri::WebviewWindow,
    frames: State<'_, screen::FrameStore>,
    paused: bool,
) -> Result<(), String> {
    require_host(&window)?;
    frames.set_paused(paused);
    Ok(())
}

#[tauri::command]
fn set_low_data_mode(
    window: tauri::WebviewWindow,
    frames: State<'_, screen::FrameStore>,
    enabled: bool,
) -> Result<(), String> {
    require_host(&window)?;
    frames.set_low_data(enabled);
    Ok(())
}

#[tauri::command]
fn disconnect(
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
    peer: String,
) -> Result<(), String> {
    require_host(&window)?;
    authority.disconnect(&peer);
    Ok(())
}

#[tauri::command]
fn stop(window: tauri::WebviewWindow, authority: State<'_, Authority>) -> Result<(), String> {
    require_host(&window)?;
    authority.stop();
    Ok(())
}

#[tauri::command]
fn replace_password(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    authority: State<'_, Authority>,
) -> Result<(), String> {
    require_host(&window)?;
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
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|arg| arg == "--show") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            use tauri::{
                menu::{Menu, MenuItem},
                tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
            };
            let open = MenuItem::with_id(app, "open", "Open Ninja Desk", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Ninja Desk", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            if cfg!(debug_assertions)
                || !cfg!(windows)
                || std::env::args().any(|arg| arg == "--show")
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }
            let data_dir = app.path().app_data_dir()?;
            let authority = Authority::load(&data_dir).map_err(std::io::Error::other)?;
            if cfg!(windows)
                && !cfg!(debug_assertions)
                && !data_dir.join("startup-choice-v1").exists()
            {
                if app.autolaunch().is_enabled().unwrap_or(false)
                    || app.autolaunch().enable().is_ok()
                {
                    let _ = std::fs::write(data_dir.join("startup-choice-v1"), b"default-on");
                }
            }
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
            create_access_link,
            approve_trusted_pc,
            revoke_trusted_pc,
            load_trusted_controller,
            save_trusted_controller,
            forget_trusted_controller,
            get_start_on_login,
            set_start_on_login,
            revoke_access_link,
            access_link_active,
            begin_auth,
            finish_auth,
            mouse,
            write_clipboard,
            read_clipboard,
            active_peer,
            read_frame,
            set_screen_capture_paused,
            set_low_data_mode,
            disconnect,
            stop,
            replace_password,
            open_controller,
            open_browser_host,
            transport_mode
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
