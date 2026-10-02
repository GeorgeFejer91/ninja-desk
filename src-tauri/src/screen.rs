use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use enigo::{Enigo, Mouse, Settings};
use image::codecs::jpeg::JpegEncoder;
use image::DynamicImage;
#[cfg(target_os = "linux")]
use screenshots::Screen as Monitor;
use serde::Serialize;
use tauri::{AppHandle, Manager};
#[cfg(not(target_os = "linux"))]
use xcap::Monitor;

use crate::authority::Authority;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    jpeg_base64: String,
    width: u32,
    height: u32,
    cursor_x: i32,
    cursor_y: i32,
}

#[derive(Default)]
pub struct FrameStore {
    frame: Mutex<(u64, Option<Frame>)>,
    paused: AtomicBool,
}

#[derive(Serialize)]
pub struct FrameResult {
    seq: u64,
    payload: Frame,
}

#[cfg(target_os = "linux")]
fn primary_monitor() -> Option<Monitor> {
    let monitors = Monitor::all().ok()?;
    monitors
        .iter()
        .find(|item| item.display_info.is_primary)
        .copied()
        .or_else(|| monitors.into_iter().next())
}

#[cfg(not(target_os = "linux"))]
fn primary_monitor() -> Option<Monitor> {
    let monitors = Monitor::all().ok()?;
    monitors
        .iter()
        .find(|item| item.is_primary().unwrap_or(false))
        .cloned()
        .or_else(|| monitors.into_iter().next())
}

#[cfg(target_os = "linux")]
fn capture(monitor: &Monitor) -> Option<image::RgbaImage> {
    let captured = monitor.capture().ok()?;
    image::RgbaImage::from_raw(captured.width(), captured.height(), captured.into_raw())
}

#[cfg(not(target_os = "linux"))]
fn capture(monitor: &Monitor) -> Option<image::RgbaImage> {
    monitor.capture_image().ok()
}

#[cfg(target_os = "linux")]
fn monitor_origin(monitor: &Monitor) -> (i32, i32) {
    (monitor.display_info.x, monitor.display_info.y)
}

#[cfg(not(target_os = "linux"))]
fn monitor_origin(monitor: &Monitor) -> (i32, i32) {
    (monitor.x().unwrap_or(0), monitor.y().unwrap_or(0))
}

impl FrameStore {
    pub fn latest(&self, since: u64) -> Option<FrameResult> {
        let state = self.frame.lock().ok()?;
        if state.0 <= since {
            return None;
        }
        Some(FrameResult {
            seq: state.0,
            payload: state.1.clone()?,
        })
    }

    fn put(&self, frame: Frame) {
        if let Ok(mut state) = self.frame.lock() {
            state.0 = state.0.wrapping_add(1);
            state.1 = Some(frame);
        }
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
        if let Ok(mut state) = self.frame.lock() {
            state.1 = None;
        }
    }

    fn paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let mut monitor: Option<Monitor> = None;
        let mouse = Enigo::new(&Settings::default()).ok();
        loop {
            if app.state::<Authority>().active_peer().is_none()
                || app.state::<FrameStore>().paused()
            {
                thread::sleep(Duration::from_millis(250));
                continue;
            }
            let started = Instant::now();
            if monitor.is_none() {
                monitor = primary_monitor();
            }
            let captured = monitor.as_ref().and_then(capture);
            if let Some(image) = captured {
                let (width, height) = image.dimensions();
                let mut jpeg = Vec::new();
                if JpegEncoder::new_with_quality(&mut jpeg, 70)
                    .encode_image(&DynamicImage::ImageRgba8(image))
                    .is_ok()
                    && jpeg.len() <= 2 * 1024 * 1024
                    && app.state::<Authority>().active_peer().is_some()
                    && !app.state::<FrameStore>().paused()
                {
                    let origin = monitor.as_ref().map(monitor_origin).unwrap_or((0, 0));
                    let cursor = mouse
                        .as_ref()
                        .and_then(|mouse| mouse.location().ok())
                        .map(|(x, y)| (x - origin.0, y - origin.1))
                        .unwrap_or((-1, -1));
                    let frame = Frame {
                        jpeg_base64: base64::engine::general_purpose::STANDARD.encode(jpeg),
                        width,
                        height,
                        cursor_x: cursor.0,
                        cursor_y: cursor.1,
                    };
                    app.state::<FrameStore>().put(frame);
                }
            } else {
                monitor = None;
            }
            let elapsed = started.elapsed();
            if elapsed < Duration::from_millis(33) {
                thread::sleep(Duration::from_millis(33) - elapsed);
            }
        }
    });
}
