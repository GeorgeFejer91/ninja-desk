use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use arboard::Clipboard;
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Mouse, Settings};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows_dpapi::{decrypt_data, encrypt_data, Scope};

type HmacSha256 = Hmac<Sha256>;
const MAX_CLIPBOARD_BYTES: usize = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub room: String,
    pub stream_id: String,
    pub password: String,
    pub generation: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub nonce: String,
    pub generation: String,
    pub host_cert: String,
    pub client_cert: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResult {
    pub proof: String,
    pub width: i32,
    pub height: i32,
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub media_password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseCommand {
    pub peer: String,
    pub seq: u64,
    pub op: u8,
    pub x: u16,
    pub y: u16,
    pub arg: i16,
    pub mac: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardCommand {
    pub peer: String,
    pub seq: u64,
    pub text: String,
    pub mac: String,
}

struct Pending {
    peer: String,
    nonce: String,
    host_cert: String,
    client_cert: String,
    started: Instant,
}

struct Grant {
    peer: String,
    key: [u8; 32],
    seq: u64,
    started: Instant,
    display: (i32, i32),
}

struct Inner {
    bootstrap: Bootstrap,
    secret: [u8; 32],
    pending: Option<Pending>,
    grant: Option<Grant>,
    mouse: Option<Enigo>,
    left_down: bool,
    clipboard: Option<Clipboard>,
    last_clipboard: Option<String>,
    available: bool,
}

pub struct Authority(Mutex<Inner>);

fn random_hex() -> String {
    hex::encode(rand::random::<[u8; 16]>())
}

fn hmac(key: &[u8], data: &str) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().into()
}

fn valid_peer(peer: &str) -> bool {
    !peer.is_empty()
        && peer.len() <= 128
        && peer
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl Authority {
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|_| "secret_store_failed")?;
        let path = data_dir.join("access-secret.dpapi");
        let secret = if path.exists() {
            Self::read_secret(&path)?
        } else {
            let fresh = rand::random::<[u8; 32]>();
            let encrypted =
                encrypt_data(&fresh, Scope::User, None).map_err(|_| "secret_store_failed")?;
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    file.write_all(&encrypted)
                        .map_err(|_| "secret_store_failed")?;
                    file.sync_all().map_err(|_| "secret_store_failed")?;
                    fresh
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Self::read_secret(&path)?
                }
                Err(_) => return Err("secret_store_failed".into()),
            }
        };
        Ok(Self::from_secret(secret))
    }

    fn read_secret(path: &Path) -> Result<[u8; 32], String> {
        let encrypted = fs::read(path).map_err(|_| "secret_store_failed")?;
        if encrypted.is_empty() || encrypted.len() > 4096 {
            return Err("secret_store_invalid".into());
        }
        let raw =
            decrypt_data(&encrypted, Scope::User, None).map_err(|_| "secret_store_invalid")?;
        raw.try_into().map_err(|_| "secret_store_invalid".into())
    }

    fn from_secret(secret: [u8; 32]) -> Self {
        let room = hex::encode(Sha256::digest(secret))[..32].to_owned();
        Self(Mutex::new(Inner {
            bootstrap: Bootstrap {
                stream_id: format!("host_{room}"),
                room,
                password: hex::encode(secret),
                generation: random_hex(),
            },
            secret,
            pending: None,
            grant: None,
            mouse: None,
            left_down: false,
            clipboard: None,
            last_clipboard: None,
            available: true,
        }))
    }

    pub fn bootstrap(&self) -> Result<Bootstrap, String> {
        let inner = self.0.lock().map_err(|_| "state_error")?;
        Ok(Bootstrap {
            room: inner.bootstrap.room.clone(),
            stream_id: inner.bootstrap.stream_id.clone(),
            password: inner.bootstrap.password.clone(),
            generation: inner.bootstrap.generation.clone(),
        })
    }

    pub fn begin_auth(
        &self,
        peer: String,
        host_cert: String,
        client_cert: String,
    ) -> Result<Challenge, String> {
        let valid_cert =
            |cert: &str| cert.len() == 64 && cert.bytes().all(|b| b.is_ascii_hexdigit());
        if !valid_peer(&peer) || !valid_cert(&host_cert) || !valid_cert(&client_cert) {
            return Err("invalid_peer".into());
        }
        let mut inner = self.0.lock().map_err(|_| "state_error")?;
        if !inner.available || inner.grant.is_some() {
            return Err("unavailable".into());
        }
        let nonce = random_hex();
        inner.pending = Some(Pending {
            peer,
            nonce: nonce.clone(),
            host_cert: host_cert.clone(),
            client_cert: client_cert.clone(),
            started: Instant::now(),
        });
        Ok(Challenge {
            nonce,
            generation: inner.bootstrap.generation.clone(),
            host_cert,
            client_cert,
        })
    }

    pub fn finish_auth(
        &self,
        peer: String,
        client_nonce: String,
        proof: String,
    ) -> Result<AuthResult, String> {
        if !valid_peer(&peer)
            || client_nonce.len() != 32
            || !client_nonce.bytes().all(|b| b.is_ascii_hexdigit())
            || proof.len() != 64
        {
            return Err("invalid_auth".into());
        }
        let mut inner = self.0.lock().map_err(|_| "state_error")?;
        if !inner.available || inner.grant.is_some() {
            return Err("unavailable".into());
        }
        let pending = inner.pending.take().ok_or("invalid_auth")?;
        if pending.peer != peer || pending.started.elapsed() > Duration::from_secs(30) {
            return Err("invalid_auth".into());
        }
        let transcript = format!(
            "v1|{}|{}|{}|{}|{}|{}|{}",
            inner.bootstrap.room,
            inner.bootstrap.generation,
            peer,
            pending.nonce,
            client_nonce,
            pending.host_cert,
            pending.client_cert
        );
        let supplied = hex::decode(proof).map_err(|_| "invalid_auth")?;
        let mut verifier = HmacSha256::new_from_slice(&inner.secret).map_err(|_| "state_error")?;
        verifier.update(format!("client|{transcript}").as_bytes());
        verifier
            .verify_slice(&supplied)
            .map_err(|_| "invalid_auth")?;

        let mouse = Enigo::new(&Settings::default()).map_err(|_| "mouse_unavailable")?;
        let display = mouse.main_display().map_err(|_| "display_unavailable")?;
        let cursor = mouse.location().unwrap_or((display.0 / 2, display.1 / 2));
        let key = hmac(&inner.secret, &format!("session|{transcript}"));
        let host_proof = hex::encode(hmac(&inner.secret, &format!("host|{transcript}")));
        let media_password = hex::encode(hmac(&key, "media|v1"));
        inner.mouse = Some(mouse);
        inner.grant = Some(Grant {
            peer,
            key,
            seq: 0,
            started: Instant::now(),
            display,
        });
        inner.last_clipboard = None;
        Ok(AuthResult {
            proof: host_proof,
            width: display.0,
            height: display.1,
            cursor_x: cursor.0,
            cursor_y: cursor.1,
            media_password,
        })
    }

    fn verify(
        inner: &mut Inner,
        peer: &str,
        seq: u64,
        mac: &str,
        message: &str,
    ) -> Result<(), String> {
        let grant = inner.grant.as_mut().ok_or("unauthorized")?;
        if grant.peer != peer || grant.started.elapsed() > Duration::from_secs(24 * 60 * 60) {
            return Err("unauthorized".into());
        }
        if seq <= grant.seq {
            return Err("stale_command".into());
        }
        if mac.len() != 64 {
            return Err("invalid_mac".into());
        }
        let supplied = hex::decode(mac).map_err(|_| "invalid_mac")?;
        let mut verifier = HmacSha256::new_from_slice(&grant.key).map_err(|_| "state_error")?;
        verifier.update(message.as_bytes());
        verifier
            .verify_slice(&supplied)
            .map_err(|_| "invalid_mac")?;
        grant.seq = seq;
        Ok(())
    }

    pub fn mouse(&self, command: MouseCommand) -> Result<(), String> {
        let mut inner = self.0.lock().map_err(|_| "state_error")?;
        if !matches!(command.op, 1..=8) || (command.op >= 7 && !(-5..=5).contains(&command.arg)) {
            return Err("invalid_mouse".into());
        }
        let message = format!(
            "mouse|{}|{}|{}|{}|{}|{}|{}",
            inner.bootstrap.generation,
            command.peer,
            command.seq,
            command.op,
            command.x,
            command.y,
            command.arg
        );
        Self::verify(
            &mut inner,
            &command.peer,
            command.seq,
            &command.mac,
            &message,
        )?;
        let expected_display = inner.grant.as_ref().map(|grant| grant.display);
        let mouse = inner.mouse.as_mut().ok_or("mouse_unavailable")?;
        let current_display = mouse.main_display().map_err(|_| "display_unavailable")?;
        if Some(current_display) != expected_display
            || current_display.0 < 1
            || current_display.1 < 1
        {
            return Err("display_changed".into());
        }
        let x = i64::from(command.x) * i64::from(current_display.0 - 1) / 65_535;
        let y = i64::from(command.y) * i64::from(current_display.1 - 1) / 65_535;
        mouse
            .move_mouse(x as i32, y as i32, Coordinate::Abs)
            .map_err(|_| "mouse_failed")?;
        match command.op {
            1 => {}
            2 => {
                mouse
                    .button(Button::Left, Direction::Press)
                    .map_err(|_| "mouse_failed")?;
                inner.left_down = true;
            }
            3 => {
                mouse
                    .button(Button::Left, Direction::Release)
                    .map_err(|_| "mouse_failed")?;
                inner.left_down = false;
            }
            4 => mouse
                .button(Button::Left, Direction::Click)
                .map_err(|_| "mouse_failed")?,
            5 => mouse
                .button(Button::Right, Direction::Click)
                .map_err(|_| "mouse_failed")?,
            6 => mouse
                .button(Button::Middle, Direction::Click)
                .map_err(|_| "mouse_failed")?,
            7 => mouse
                .scroll(i32::from(command.arg), Axis::Vertical)
                .map_err(|_| "mouse_failed")?,
            8 => mouse
                .scroll(i32::from(command.arg), Axis::Horizontal)
                .map_err(|_| "mouse_failed")?,
            _ => return Err("invalid_mouse".into()),
        }
        Ok(())
    }

    pub fn write_clipboard(&self, command: ClipboardCommand) -> Result<(), String> {
        if command.text.len() > MAX_CLIPBOARD_BYTES {
            return Err("clipboard_too_large".into());
        }
        let mut inner = self.0.lock().map_err(|_| "state_error")?;
        let digest = hex::encode(Sha256::digest(command.text.as_bytes()));
        let message = format!(
            "clipboard|{}|{}|{}|{}",
            inner.bootstrap.generation, command.peer, command.seq, digest
        );
        Self::verify(
            &mut inner,
            &command.peer,
            command.seq,
            &command.mac,
            &message,
        )?;
        if inner.clipboard.is_none() {
            inner.clipboard = Some(Clipboard::new().map_err(|_| "clipboard_unavailable")?);
        }
        let clipboard = inner.clipboard.as_mut().ok_or("clipboard_unavailable")?;
        clipboard
            .set_text(command.text.clone())
            .map_err(|_| "clipboard_failed")?;
        inner.last_clipboard = Some(command.text);
        Ok(())
    }

    pub fn read_clipboard(&self) -> Result<Option<String>, String> {
        let mut inner = self.0.lock().map_err(|_| "state_error")?;
        if inner.grant.is_none() {
            return Ok(None);
        }
        if inner.clipboard.is_none() {
            inner.clipboard = Some(Clipboard::new().map_err(|_| "clipboard_unavailable")?);
        }
        let clipboard = inner.clipboard.as_mut().ok_or("clipboard_unavailable")?;
        let text = match clipboard.get_text() {
            Ok(text) if text.len() <= MAX_CLIPBOARD_BYTES => text,
            _ => return Ok(None),
        };
        if inner.last_clipboard.as_ref() == Some(&text) {
            return Ok(None);
        }
        inner.last_clipboard = Some(text.clone());
        Ok(Some(text))
    }

    pub fn active_peer(&self) -> Option<String> {
        let mut inner = self.0.lock().ok()?;
        if inner
            .grant
            .as_ref()
            .is_some_and(|grant| grant.started.elapsed() > Duration::from_secs(24 * 60 * 60))
        {
            Self::revoke(&mut inner);
        }
        inner.grant.as_ref().map(|grant| grant.peer.clone())
    }

    pub fn disconnect(&self, peer: &str) {
        if let Ok(mut inner) = self.0.lock() {
            if inner.grant.as_ref().is_some_and(|grant| grant.peer == peer) {
                Self::revoke(&mut inner);
            }
        }
    }

    pub fn stop(&self) {
        if let Ok(mut inner) = self.0.lock() {
            inner.available = false;
            Self::revoke(&mut inner);
        }
    }

    pub fn replace_password(&self, data_dir: &Path) -> Result<(), String> {
        let mut inner = self.0.lock().map_err(|_| "state_error")?;
        inner.available = false;
        Self::revoke(&mut inner);
        let fresh = rand::random::<[u8; 32]>();
        let encrypted =
            encrypt_data(&fresh, Scope::User, None).map_err(|_| "secret_store_failed")?;
        let temp = data_dir.join(format!("access-secret-{}.dpapi", random_hex()));
        let path = data_dir.join("access-secret.dpapi");
        let result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|_| "secret_store_failed")?;
            file.write_all(&encrypted)
                .map_err(|_| "secret_store_failed")?;
            file.sync_all().map_err(|_| "secret_store_failed")?;
            drop(file);
            fs::rename(&temp, &path).map_err(|_| "secret_store_failed".into())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    fn revoke(inner: &mut Inner) {
        if inner.left_down {
            if let Some(mouse) = inner.mouse.as_mut() {
                let _ = mouse.button(Button::Left, Direction::Release);
            }
        }
        inner.left_down = false;
        inner.grant = None;
        inner.pending = None;
        inner.mouse = None;
        inner.last_clipboard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_peer_and_proof() {
        assert!(!valid_peer("../../x"));
        assert!(valid_peer("browser_1"));
        let authority = Authority::from_secret([7; 32]);
        assert!(authority
            .begin_auth("../../x".into(), "0".repeat(64), "1".repeat(64))
            .is_err());
        let challenge = authority
            .begin_auth("browser_1".into(), "0".repeat(64), "1".repeat(64))
            .unwrap();
        assert_eq!(challenge.host_cert, "0".repeat(64));
        assert_eq!(challenge.client_cert, "1".repeat(64));
        assert!(authority
            .finish_auth("browser_1".into(), "2".repeat(32), "3".repeat(64))
            .is_err());
    }

    #[test]
    fn signed_command_rejects_replay() {
        let authority = Authority::from_secret([7; 32]);
        let mut inner = authority.0.lock().unwrap();
        let key = [9; 32];
        inner.grant = Some(Grant {
            peer: "browser_1".into(),
            key,
            seq: 0,
            started: Instant::now(),
            display: (1920, 1080),
        });
        let message = "mouse|generation|browser_1|1|1|1|1|0";
        let mac = hex::encode(hmac(&key, message));
        assert!(Authority::verify(&mut inner, "browser_1", 1, &mac, message).is_ok());
        assert_eq!(
            Authority::verify(&mut inner, "browser_1", 1, &mac, message).unwrap_err(),
            "stale_command"
        );
    }

    #[test]
    fn replacing_password_revokes_old_access_and_survives_restart() {
        let dir = std::env::temp_dir().join(format!("vdo-remote-test-{}", random_hex()));
        let first = Authority::load(&dir).unwrap();
        let old_password = first.bootstrap().unwrap().password;
        first.replace_password(&dir).unwrap();
        assert_eq!(
            first
                .begin_auth("browser_1".into(), "0".repeat(64), "1".repeat(64))
                .err()
                .unwrap(),
            "unavailable"
        );
        let restarted = Authority::load(&dir).unwrap();
        assert_ne!(restarted.bootstrap().unwrap().password, old_password);
        fs::remove_file(dir.join("access-secret.dpapi")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
