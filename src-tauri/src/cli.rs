//! Small, user-scoped control channel for the installed console companion.
//! The endpoint and its random bearer key are protected with the same store as pairing secrets.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::authority::{self, Authority};
use crate::screen::FrameStore;

const MAX_REQUEST_BYTES: u64 = 16 * 1024;
const MAX_RESPONSE_BYTES: u64 = 32 * 1024;
const ACTION_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub phase: String,
    pub authenticated: bool,
    pub remembered: bool,
    pub retry_scheduled: bool,
    pub media_active: bool,
    pub frames: u64,
    pub last_frame_age_ms: Option<u64>,
    pub route: String,
}

impl RuntimeStatus {
    pub(crate) fn valid(&self) -> bool {
        matches!(
            self.phase.as_str(),
            "offline"
                | "connecting"
                | "authenticating"
                | "control_ready"
                | "media_ready"
                | "reconnecting"
                | "stopped"
                | "revoked"
                | "error"
        ) && matches!(self.route.as_str(), "direct" | "relayed" | "unknown")
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CliAction {
    ControllerConnect {
        #[serde(default)]
        password: Option<String>,
        #[serde(default, rename = "hostId")]
        host_id: Option<String>,
    },
    ControllerDisconnect,
    ControllerForget {
        #[serde(default, rename = "hostId")]
        host_id: Option<String>,
    },
    ControllerProbe,
    ControllerClipboardSend {
        text: String,
    },
    HostPairApprove,
    HostPairRevoke,
}

impl CliAction {
    fn label(&self) -> &'static str {
        match self {
            Self::HostPairApprove | Self::HostPairRevoke => "main",
            _ => "controller",
        }
    }

    pub(crate) fn valid(&self) -> bool {
        match self {
            Self::ControllerConnect { password, host_id } => {
                password.as_ref().is_none_or(|value| is_hex(value, 64))
                    && host_id.as_ref().is_none_or(|value| is_hex(value, 32))
            }
            Self::ControllerForget { host_id } => {
                host_id.as_ref().is_none_or(|value| is_hex(value, 32))
            }
            Self::ControllerClipboardSend { text } => text.len() <= 4096,
            _ => true,
        }
    }
}

fn is_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionEvent {
    request_id: String,
    action: CliAction,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct WireResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

impl WireResponse {
    fn error(code: &str) -> Self {
        Self {
            ok: false,
            code: Some(code.into()),
            data: None,
        }
    }

    fn data(data: Value) -> Self {
        Self {
            ok: true,
            code: None,
            data: Some(data),
        }
    }
}

struct Pending {
    label: &'static str,
    sender: mpsc::Sender<WireResponse>,
}

#[derive(Default)]
pub struct CliRuntime {
    reports: Mutex<HashMap<String, (RuntimeStatus, Instant)>>,
    pending: Mutex<HashMap<String, Pending>>,
}

impl CliRuntime {
    pub fn clear_report(&self, label: &str) {
        if let Ok(mut reports) = self.reports.lock() {
            reports.remove(label);
        }
    }
    pub fn report(&self, label: &str, status: RuntimeStatus) -> Result<(), String> {
        if !matches!(label, "main" | "controller") || !status.valid() {
            return Err("invalid_status".into());
        }
        self.reports
            .lock()
            .map_err(|_| "unavailable")?
            .insert(label.into(), (status, Instant::now()));
        Ok(())
    }

    pub fn complete(
        &self,
        label: &str,
        request_id: &str,
        result: ActionResult,
    ) -> Result<(), String> {
        if !is_hex(request_id, 32)
            || result.code.as_ref().is_some_and(|code| {
                code.len() > 64
                    || !code
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            })
            || result
                .data
                .as_ref()
                .is_some_and(|data| !safe_action_data(data))
        {
            return Err("invalid_result".into());
        }
        let mut pending = self.pending.lock().map_err(|_| "unavailable")?;
        if pending
            .get(request_id)
            .is_none_or(|item| item.label != label)
        {
            return Err("unknown_request".into());
        }
        if let Some(item) = pending.remove(request_id) {
            let _ = item.sender.send(WireResponse {
                ok: result.ok,
                code: result.code,
                data: result.data,
            });
        }
        Ok(())
    }
}

fn safe_action_data(data: &Value) -> bool {
    let Some(fields) = data.as_object() else {
        return false;
    };
    fields.len() <= 4
        && fields.iter().all(|(key, value)| match key.as_str() {
            "roundTripMs" => value.as_u64().is_some_and(|ms| ms <= 60_000),
            "accepted" | "acknowledged" | "connected" | "remembered" | "revoked"
            | "disconnected" | "forgotten" | "sent" => value.is_boolean(),
            _ => false,
        })
}

#[derive(Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
    pid: u32,
}

#[derive(Serialize, Deserialize)]
struct WireRequest {
    token: String,
    command: String,
    #[serde(default)]
    action: Option<CliAction>,
}

fn endpoint_path(data_dir: &Path) -> PathBuf {
    data_dir.join(if cfg!(windows) {
        "cli-endpoint.dpapi"
    } else {
        "cli-endpoint.bin"
    })
}

fn token_matches(expected: &str, supplied: &str) -> bool {
    if expected.len() != 64 || supplied.len() != 64 {
        return false;
    }
    expected
        .bytes()
        .zip(supplied.bytes())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

pub fn start(app: AppHandle, data_dir: &Path) -> Result<(), String> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "cli_bind_failed")?;
    let token = hex::encode(rand::random::<[u8; 32]>());
    let endpoint = Endpoint {
        port: listener.local_addr().map_err(|_| "cli_bind_failed")?.port(),
        token,
        pid: std::process::id(),
    };
    authority::write_protected(
        &endpoint_path(data_dir),
        &serde_json::to_vec(&endpoint).map_err(|_| "cli_bind_failed")?,
    )?;
    let active = Arc::new(AtomicUsize::new(0));
    thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(stream) = connection else { continue };
            if active.fetch_add(1, Ordering::Relaxed) >= 8 {
                active.fetch_sub(1, Ordering::Relaxed);
                continue;
            }
            let app = app.clone();
            let endpoint_token = endpoint.token.clone();
            let active = active.clone();
            thread::spawn(move || {
                let _ = serve_one(stream, &app, &endpoint_token);
                active.fetch_sub(1, Ordering::Relaxed);
            });
        }
    });
    Ok(())
}

fn serve_one(mut stream: TcpStream, app: &AppHandle, token: &str) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| "cli_io_failed")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| "cli_io_failed")?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut stream)
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cli_io_failed")?;
    let response = if bytes.len() as u64 > MAX_REQUEST_BYTES {
        WireResponse::error("request_too_large")
    } else if let Ok(request) = serde_json::from_slice::<WireRequest>(&bytes) {
        if !token_matches(token, &request.token) {
            WireResponse::error("unauthorized")
        } else {
            match request.command.as_str() {
                "status" | "doctor" => status(app, request.command == "doctor"),
                "action" => match request.action {
                    Some(action) if action.valid() => dispatch(app, action),
                    _ => WireResponse::error("invalid_action"),
                },
                "host_restart" => {
                    let old_pid = std::process::id();
                    let app = app.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(200));
                        app.request_restart();
                    });
                    WireResponse::data(json!({"restarting":true,"oldPid":old_pid}))
                }
                _ => WireResponse::error("unknown_command"),
            }
        }
    } else {
        WireResponse::error("invalid_request")
    };
    let encoded = serde_json::to_vec(&response).map_err(|_| "cli_io_failed")?;
    stream.write_all(&encoded).map_err(|_| "cli_io_failed")?;
    stream.write_all(b"\n").map_err(|_| "cli_io_failed")?;
    Ok(())
}

fn status(app: &AppHandle, doctor: bool) -> WireResponse {
    let runtime = app.state::<CliRuntime>();
    let reports = runtime.reports.lock().ok();
    let report = |label: &str| {
        reports.as_ref().and_then(|guard| guard.get(label)).map(
            |(status, at)| json!({"status":status,"reportAgeMs":at.elapsed().as_millis() as u64}),
        )
    };
    let authority = app.state::<Authority>();
    let frames = app.state::<FrameStore>().stats();
    let capture_running = !frames.paused && frames.last_frame_age_ms.is_some_and(|age| age <= 2000);
    let data_dir = app.path().app_data_dir().ok();
    let saved_count = data_dir
        .as_ref()
        .and_then(|dir| authority::list_saved_computers(dir).ok())
        .map(|entries| entries.len());
    WireResponse::data(json!({
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
        "host": {
            "active": authority.active_peer().is_some(),
            "trustedPc": authority.has_trusted_pc(),
            "capture": frames,
            "runtime": report("main"),
        },
        "controller": {
            "windowOpen": app.get_webview_window("controller").is_some(),
            "savedComputers": saved_count,
            "runtime": report("controller"),
        },
        "doctor": doctor.then_some(json!({
            "localIpc": "ready",
            "hostAuthority": "ready",
            "captureRunning": capture_running,
        })),
    }))
}

pub(crate) fn dispatch(app: &AppHandle, action: CliAction) -> WireResponse {
    let label = action.label();
    if cfg!(target_os = "linux") && label == "controller" {
        return WireResponse::error("use_browser_controller");
    }
    if label == "controller" && crate::ensure_controller_window(app, false).is_err() {
        return WireResponse::error("window_failed");
    }
    let runtime = app.state::<CliRuntime>();
    if label == "controller" {
        let deadline = Instant::now() + Duration::from_secs(5);
        let ready = || {
            runtime.reports.lock().is_ok_and(|reports| {
                reports
                    .get("controller")
                    .is_some_and(|(_, at)| at.elapsed() < Duration::from_secs(2))
            })
        };
        while Instant::now() < deadline {
            if ready() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        if !ready() {
            return WireResponse::error("runtime_unavailable");
        }
    }
    let request_id = hex::encode(rand::random::<[u8; 16]>());
    let (sender, receiver) = mpsc::channel();
    if let Ok(mut pending) = runtime.pending.lock() {
        if pending.values().any(|item| item.label == label) {
            return WireResponse::error("busy");
        }
        pending.insert(request_id.clone(), Pending { label, sender });
    } else {
        return WireResponse::error("unavailable");
    }
    let event = ActionEvent {
        request_id: request_id.clone(),
        action,
    };
    if app.emit_to(label, "ninja-cli-action", event).is_err() {
        if let Ok(mut pending) = runtime.pending.lock() {
            pending.remove(&request_id);
        }
        return WireResponse::error("window_unavailable");
    }
    let result = receiver
        .recv_timeout(ACTION_TIMEOUT)
        .unwrap_or_else(|_| WireResponse::error("action_timeout"));
    if let Ok(mut pending) = runtime.pending.lock() {
        pending.remove(&request_id);
    }
    result
}

fn app_data_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        return std::env::var_os("APPDATA")
            .map(|root| PathBuf::from(root).join("dev.local.vdoninjaremote"))
            .ok_or("app_data_unavailable".into());
    }
    #[cfg(not(windows))]
    {
        if let Some(root) = std::env::var_os("XDG_DATA_HOME") {
            return Ok(PathBuf::from(root).join("dev.local.vdoninjaremote"));
        }
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(".local/share/dev.local.vdoninjaremote"))
            .ok_or("app_data_unavailable".into())
    }
}

fn send_request(command: &str, action: Option<CliAction>) -> Result<WireResponse, String> {
    let data_dir = app_data_dir()?;
    let endpoint: Endpoint = serde_json::from_slice(
        &authority::read_protected(&endpoint_path(&data_dir)).map_err(|_| "app_not_running")?,
    )
    .map_err(|_| "app_not_running")?;
    if !is_hex(&endpoint.token, 64) {
        return Err("app_not_running".into());
    }
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port);
    let mut stream = TcpStream::connect_timeout(&address.into(), Duration::from_secs(2))
        .map_err(|_| "app_not_running")?;
    stream
        .set_read_timeout(Some(ACTION_TIMEOUT + Duration::from_secs(2)))
        .map_err(|_| "cli_io_failed")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "cli_io_failed")?;
    let bytes = serde_json::to_vec(&WireRequest {
        token: endpoint.token,
        command: command.into(),
        action,
    })
    .map_err(|_| "invalid_request")?;
    stream.write_all(&bytes).map_err(|_| "cli_io_failed")?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|_| "cli_io_failed")?;
    let mut reply = Vec::new();
    stream
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut reply)
        .map_err(|_| "cli_io_failed")?;
    if reply.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("invalid_response".into());
    }
    serde_json::from_slice(&reply).map_err(|_| "invalid_response".into())
}

fn read_stdin(limit: u64) -> Result<String, String> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "stdin_failed")?;
    if bytes.len() as u64 > limit {
        return Err("stdin_too_large".into());
    }
    String::from_utf8(bytes).map_err(|_| "stdin_invalid".into())
}

fn parse_args(args: &[String]) -> Result<(String, Option<CliAction>), String> {
    let first = args.first().map(String::as_str);
    match first {
        Some("status") | Some("doctor")
            if args.len() == 1
                || args.get(1).map(String::as_str) == Some("--json") && args.len() == 2 =>
        {
            Ok((first.unwrap().into(), None))
        }
        Some("controller") => match args.get(1).map(String::as_str) {
            Some("connect") => {
                let mut password_stdin = false;
                let mut host_id = None;
                let mut index = 2;
                while index < args.len() {
                    match args[index].as_str() {
                        "--password-stdin" if !password_stdin => password_stdin = true,
                        "--device" if host_id.is_none() => {
                            index += 1;
                            host_id = args.get(index).cloned();
                            if host_id.is_none() {
                                return Err("invalid_arguments".into());
                            }
                        }
                        _ => return Err("invalid_arguments".into()),
                    }
                    index += 1;
                }
                let password = if password_stdin {
                    let password = read_stdin(128)?.trim().to_owned();
                    if !is_hex(&password, 64) {
                        return Err("invalid_password".into());
                    }
                    Some(password)
                } else {
                    None
                };
                let action = CliAction::ControllerConnect { password, host_id };
                if !action.valid() {
                    return Err("invalid_arguments".into());
                }
                Ok(("action".into(), Some(action)))
            }
            Some("disconnect") if args.len() == 2 => {
                Ok(("action".into(), Some(CliAction::ControllerDisconnect)))
            }
            Some("forget") if args.len() == 2 || args.len() == 4 && args[2] == "--device" => {
                let host_id = args.get(3).cloned();
                let action = CliAction::ControllerForget { host_id };
                if !action.valid() {
                    return Err("invalid_arguments".into());
                }
                Ok(("action".into(), Some(action)))
            }
            Some("probe") if args.len() == 2 => {
                Ok(("action".into(), Some(CliAction::ControllerProbe)))
            }
            Some("clipboard-send") if args.len() == 3 && args[2] == "--stdin" => Ok((
                "action".into(),
                Some(CliAction::ControllerClipboardSend {
                    text: read_stdin(4096)?,
                }),
            )),
            _ => Err("invalid_arguments".into()),
        },
        Some("host") if args.len() == 3 && args[1] == "pair" && args[2] == "approve" => {
            Ok(("action".into(), Some(CliAction::HostPairApprove)))
        }
        Some("host") if args.len() == 3 && args[1] == "pair" && args[2] == "revoke" => {
            Ok(("action".into(), Some(CliAction::HostPairRevoke)))
        }
        Some("host") if args.len() == 2 && args[1] == "restart" => {
            Ok(("host_restart".into(), None))
        }
        _ => Err("invalid_arguments".into()),
    }
}

pub fn cli_main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.as_slice() == ["--help"] || args.as_slice() == ["help"] {
        println!("Ninja Desk CLI\nstatus [--json]\ndoctor [--json]\ncontroller connect [--device HOST_ID] [--password-stdin]\ncontroller disconnect\ncontroller forget [--device HOST_ID]\ncontroller probe\ncontroller clipboard-send --stdin\nhost pair approve\nhost pair revoke\nhost restart\n\nCommands return redacted JSON. Access codes and clipboard text are read only from stdin.");
        return;
    }
    if args.as_slice() == ["--version"] {
        println!("Ninja Desk {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let result = parse_args(&args).and_then(|(command, action)| send_request(&command, action));
    let response = result.unwrap_or_else(|code| WireResponse::error(&code));
    println!(
        "{}",
        serde_json::to_string(&response)
            .unwrap_or_else(|_| "{\"ok\":false,\"code\":\"unavailable\"}".into())
    );
    if !response.ok {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_boundary_rejects_secret_arguments_and_unapproved_output() {
        let args = ["controller", "connect", "--password", "secret"].map(String::from);
        assert_eq!(
            parse_args(&args).err().as_deref(),
            Some("invalid_arguments")
        );
        let args = ["controller", "connect", "--device", "bad"].map(String::from);
        assert!(parse_args(&args).is_err());
        assert!(!safe_action_data(&json!({"secret":"private"})));
        assert!(!safe_action_data(&json!({"roundTripMs":-1})));
        assert!(safe_action_data(
            &json!({"acknowledged":true,"roundTripMs":27})
        ));
        assert!(!token_matches(&"a".repeat(64), &"b".repeat(64)));
        assert!(!token_matches(&"a".repeat(64), "a"));
    }
}
