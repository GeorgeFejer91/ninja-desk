use std::io::Read;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::authority::{Authority, ClipboardCommand, MouseCommand};
use crate::screen::FrameStore;

pub struct BrowserHost {
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthArgs {
    peer: String,
    host_cert: Option<String>,
    client_cert: Option<String>,
    client_nonce: Option<String>,
    proof: Option<String>,
    invite_id: Option<String>,
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn reply(request: Request, status: u16, mime: &str, body: Vec<u8>) {
    let response = Response::from_data(body)
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", mime))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Referrer-Policy", "no-referrer"));
    let _ = request.respond(response);
}

fn json_reply(request: Request, value: Result<Value, String>) {
    let (status, body) = match value {
        Ok(value) => (200, json!({ "ok": true, "value": value })),
        Err(error) => (400, json!({ "ok": false, "error": error })),
    };
    reply(
        request,
        status,
        "application/json",
        body.to_string().into_bytes(),
    );
}

fn authenticated(request: &Request, token: &str, origin: &str) -> bool {
    let mut authorized = false;
    let mut valid_host = false;
    for item in request.headers() {
        if item.field.equiv("X-Ninja-Token") && item.value.as_str() == token {
            authorized = true;
        }
        if item.field.equiv("Host") && item.value.as_str() == &origin[7..] {
            valid_host = true;
        }
        if item.field.equiv("Origin") && item.value.as_str() != origin {
            return false;
        }
    }
    authorized
        && valid_host
        && request
            .remote_addr()
            .is_some_and(|address| address.ip().is_loopback())
}

fn dispatch(app: &AppHandle, command: &str, args: Value) -> Result<Value, String> {
    let authority = app.state::<Authority>();
    match command {
        "bootstrap" => {
            serde_json::to_value(authority.bootstrap()?).map_err(|_| "state_error".into())
        }
        "create_access_link" => {
            serde_json::to_value(authority.create_access_link()?).map_err(|_| "state_error".into())
        }
        "revoke_access_link" => {
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .ok_or("invalid_invite")?;
            authority.revoke_access_link(id);
            Ok(Value::Null)
        }
        "access_link_active" => {
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .ok_or("invalid_invite")?;
            Ok(json!(authority.access_link_active(id)))
        }
        "begin_auth" => {
            let args: AuthArgs = serde_json::from_value(args).map_err(|_| "invalid_auth")?;
            serde_json::to_value(authority.begin_auth(
                args.peer,
                args.host_cert.ok_or("invalid_auth")?,
                args.client_cert.ok_or("invalid_auth")?,
                args.invite_id,
            )?)
            .map_err(|_| "state_error".into())
        }
        "finish_auth" => {
            let args: AuthArgs = serde_json::from_value(args).map_err(|_| "invalid_auth")?;
            serde_json::to_value(authority.finish_auth(
                args.peer,
                args.client_nonce.ok_or("invalid_auth")?,
                args.proof.ok_or("invalid_auth")?,
                args.invite_id,
            )?)
            .map_err(|_| "state_error".into())
        }
        "mouse" => {
            let command: MouseCommand =
                serde_json::from_value(args.get("command").cloned().ok_or("invalid_mouse")?)
                    .map_err(|_| "invalid_mouse")?;
            authority.mouse(command)?;
            Ok(Value::Null)
        }
        "write_clipboard" => {
            let command: ClipboardCommand =
                serde_json::from_value(args.get("command").cloned().ok_or("invalid_clipboard")?)
                    .map_err(|_| "invalid_clipboard")?;
            authority.write_clipboard(command)?;
            Ok(Value::Null)
        }
        "read_clipboard" => {
            serde_json::to_value(authority.read_clipboard()?).map_err(|_| "state_error".into())
        }
        "active_peer" => {
            serde_json::to_value(authority.active_peer()).map_err(|_| "state_error".into())
        }
        "read_frame" => {
            if authority.active_peer().is_none() {
                return Ok(Value::Null);
            }
            let since = args
                .get("since")
                .and_then(Value::as_u64)
                .ok_or("invalid_frame")?;
            serde_json::to_value(app.state::<FrameStore>().latest(since))
                .map_err(|_| "state_error".into())
        }
        "set_screen_capture_paused" => {
            let paused = args
                .get("paused")
                .and_then(Value::as_bool)
                .ok_or("invalid_capture")?;
            app.state::<FrameStore>().set_paused(paused);
            Ok(Value::Null)
        }
        "set_low_data_mode" => {
            let enabled = args
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("invalid_capture")?;
            app.state::<FrameStore>().set_low_data(enabled);
            Ok(Value::Null)
        }
        "disconnect" => {
            let peer = args
                .get("peer")
                .and_then(Value::as_str)
                .ok_or("invalid_peer")?;
            authority.disconnect(peer);
            Ok(Value::Null)
        }
        "stop" => {
            authority.stop();
            Ok(Value::Null)
        }
        "replace_password" => {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|_| "secret_store_failed")?;
            authority.replace_password(&data_dir)?;
            let app = app.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(250));
                app.request_restart();
            });
            Ok(Value::Null)
        }
        _ => Err("unknown_command".into()),
    }
}

fn handle(app: &AppHandle, token: &str, origin: &str, mut request: Request) {
    let path = request.url().to_owned();
    if path.starts_with("/api/") {
        if !authenticated(&request, token, origin) {
            reply(request, 403, "text/plain", b"Forbidden".to_vec());
            return;
        }
        if *request.method() != Method::Post
            || !path.starts_with("/api/")
            || request.body_length().unwrap_or(usize::MAX) > 300_000
        {
            reply(request, 400, "text/plain", b"Bad request".to_vec());
            return;
        }
        let mut body = Vec::new();
        if request
            .as_reader()
            .take(300_001)
            .read_to_end(&mut body)
            .is_err()
            || body.len() > 300_000
        {
            reply(request, 400, "text/plain", b"Bad request".to_vec());
            return;
        }
        let args = match serde_json::from_slice(&body) {
            Ok(args) => args,
            Err(_) => {
                reply(request, 400, "text/plain", b"Bad request".to_vec());
                return;
            }
        };
        json_reply(request, dispatch(app, &path[5..], args));
        return;
    }

    let valid_host = request
        .headers()
        .iter()
        .any(|item| item.field.equiv("Host") && item.value.as_str() == &origin[7..]);
    if *request.method() != Method::Get
        || !valid_host
        || path.len() > 160
        || path.contains("..")
        || !path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/._-".contains(&byte))
    {
        reply(request, 404, "text/plain", b"Not found".to_vec());
        return;
    }
    let asset_path = if path == "/" {
        "index.html"
    } else {
        &path[1..]
    };
    match app.asset_resolver().get(asset_path.to_owned()) {
        Some(asset) => {
            let response = Response::from_data(asset.bytes)
                .with_header(header("Content-Type", &asset.mime_type))
                .with_header(header("Cache-Control", "no-store"))
                .with_header(header("X-Content-Type-Options", "nosniff"))
                .with_header(header("Referrer-Policy", "no-referrer"))
                .with_header(header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss://wss.vdo.ninja https://turnservers.vdo.ninja; img-src 'self' blob:; media-src 'self' blob:"));
            let _ = request.respond(response);
        }
        None => reply(request, 404, "text/plain", b"Not found".to_vec()),
    }
}

pub fn start(app: AppHandle) -> Result<BrowserHost, String> {
    let server = Server::http("127.0.0.1:0").map_err(|_| "browser_host_failed")?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("browser_host_failed")?
        .port();
    let origin = format!("http://127.0.0.1:{port}");
    let token = hex::encode(rand::random::<[u8; 32]>());
    let url = format!("{origin}/#{token}");
    thread::spawn(move || {
        for request in server.incoming_requests() {
            handle(&app, &token, &origin, request);
        }
    });
    Ok(BrowserHost { url })
}
