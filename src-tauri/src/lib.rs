mod authority;
#[cfg(target_os = "linux")]
mod browser_host;
mod cli;
mod screen;

pub use cli::cli_main;

use authority::{
    AccessLink, AuthResult, Authority, Bootstrap, Challenge, ClipboardCommand, ControllerTrust,
    MouseCommand, TrustedGrant,
};
use tauri::{Emitter, Manager, State};
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

pub(crate) fn ensure_controller_window(
    app: &tauri::AppHandle,
    visible: bool,
) -> Result<tauri::WebviewWindow, String> {
    if let Some(controller) = app.get_webview_window("controller") {
        if visible {
            controller.show().map_err(|_| "window_failed")?;
            controller.set_focus().map_err(|_| "window_failed")?;
        }
        return Ok(controller);
    }
    app.state::<cli::CliRuntime>().clear_report("controller");
    let controller_url = if visible {
        "controller.html"
    } else {
        "controller.html?background=1"
    };
    let controller = tauri::WebviewWindowBuilder::new(
        app,
        "controller",
        tauri::WebviewUrl::App(controller_url.into()),
    )
    .title("Ninja Desk — Control another PC")
    .inner_size(1100.0, 760.0)
    .min_inner_size(640.0, 420.0)
    .visible(visible)
    .build()
    .map_err(|_| "window_failed")?;
    if visible {
        controller.set_focus().map_err(|_| "window_failed")?;
    }
    Ok(controller)
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
    }
    #[cfg(not(target_os = "linux"))]
    ensure_controller_window(&app, true)?;
    Ok(())
}

#[tauri::command]
async fn connect_controller(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    password: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("unavailable".into());
    }
    let action = cli::CliAction::ControllerConnect { password, host_id };
    if !action.valid() {
        return Err("invalid_arguments".into());
    }
    ensure_controller_window(&app, true)?;
    std::thread::spawn(move || {
        let _ = cli::dispatch(&app, action);
    });
    Ok(())
}

#[tauri::command]
fn report_runtime_status(
    window: tauri::WebviewWindow,
    runtime: State<'_, cli::CliRuntime>,
    status: cli::RuntimeStatus,
) -> Result<(), String> {
    runtime.report(window.label(), status)
}

#[tauri::command]
fn complete_cli_action(
    window: tauri::WebviewWindow,
    runtime: State<'_, cli::CliRuntime>,
    request_id: String,
    result: cli::ActionResult,
) -> Result<(), String> {
    runtime.complete(window.label(), &request_id, result)
}

#[tauri::command]
fn set_window_fullscreen(window: tauri::WebviewWindow, enabled: bool) -> Result<bool, String> {
    if !matches!(window.label(), "main" | "controller") {
        return Err("unavailable".into());
    }
    window
        .set_fullscreen(enabled)
        .map_err(|_| "window_failed")?;
    window.is_fullscreen().map_err(|_| "window_failed".into())
}

#[tauri::command]
fn get_window_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    if !matches!(window.label(), "main" | "controller") {
        return Err("unavailable".into());
    }
    window.is_fullscreen().map_err(|_| "window_failed".into())
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
    host_id: Option<String>,
) -> Result<Option<ControllerTrust>, String> {
    if window.label() != "controller" {
        return Err("unavailable".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "secret_store_failed")?;
    authority::load_controller_trust_for(&data_dir, host_id.as_deref())
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
    host_id: Option<String>,
) -> Result<(), String> {
    if window.label() != "controller" {
        return Err("unavailable".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "secret_store_failed")?;
    match host_id {
        Some(id) => authority::forget_controller_trust_for(&data_dir, &id),
        None => authority::forget_controller_trust(&data_dir),
    }
}

#[tauri::command]
fn list_saved_computers(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<authority::SavedComputerSummary>, String> {
    if !matches!(window.label(), "main" | "controller") {
        return Err("unavailable".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "secret_store_failed")?;
    authority::list_saved_computers(&data_dir)
}

#[tauri::command]
fn rename_saved_computer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host_id: String,
    name: String,
) -> Result<(), String> {
    if !matches!(window.label(), "main" | "controller") {
        return Err("unavailable".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "secret_store_failed")?;
    authority::rename_saved_computer(&data_dir, &host_id, &name)
}

#[tauri::command]
fn forget_saved_computer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host_id: String,
) -> Result<(), String> {
    if !matches!(window.label(), "main" | "controller") {
        return Err("unavailable".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "secret_store_failed")?;
    authority::forget_controller_trust_for(&data_dir, &host_id)?;
    if app.get_webview_window("controller").is_some() {
        app.emit_to(
            "controller",
            "ninja-saved-computer-forgotten",
            serde_json::json!({"hostId": host_id}),
        )
        .map_err(|_| "window_failed")?;
    }
    Ok(())
}

#[tauri::command]
fn touch_saved_computer(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    host_id: String,
    id: String,
) -> Result<(), String> {
    if window.label() != "controller" {
        return Err("unavailable".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "secret_store_failed")?;
    authority::touch_saved_computer(&data_dir, &host_id, &id)
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
            app.manage(cli::CliRuntime::default());
            cli::start(app.handle().clone(), &data_dir).map_err(std::io::Error::other)?;
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
            list_saved_computers,
            rename_saved_computer,
            forget_saved_computer,
            touch_saved_computer,
            report_runtime_status,
            complete_cli_action,
            connect_controller,
            set_window_fullscreen,
            get_window_fullscreen,
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
            if let tauri::WindowEvent::Destroyed = event {
                window
                    .state::<cli::CliRuntime>()
                    .clear_report(window.label());
            }
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
