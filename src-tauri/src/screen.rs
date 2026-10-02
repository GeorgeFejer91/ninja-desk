use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use enigo::{Enigo, Mouse, Settings};
use image::codecs::jpeg::JpegEncoder;
use image::DynamicImage;
use serde::Serialize;
use tauri::{AppHandle, Manager};
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
pub struct FrameStore(Mutex<(u64, Option<Frame>)>);

#[derive(Serialize)]
pub struct FrameResult {
    seq: u64,
    payload: Frame,
}

impl FrameStore {
    pub fn latest(&self, since: u64) -> Option<FrameResult> {
        let state = self.0.lock().ok()?;
        if state.0 <= since {
            return None;
        }
        Some(FrameResult {
            seq: state.0,
            payload: state.1.clone()?,
        })
    }

    fn put(&self, frame: Frame) {
        if let Ok(mut state) = self.0.lock() {
            state.0 = state.0.wrapping_add(1);
            state.1 = Some(frame);
        }
    }
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let mut monitor: Option<Monitor> = None;
        let mouse = Enigo::new(&Settings::default()).ok();
        loop {
            if app.state::<Authority>().active_peer().is_none() {
                thread::sleep(Duration::from_millis(250));
                continue;
            }
            let started = Instant::now();
            if monitor.is_none() {
                monitor = Monitor::all().ok().and_then(|monitors| {
                    monitors
                        .iter()
                        .find(|item| item.is_primary().unwrap_or(false))
                        .cloned()
                        .or_else(|| monitors.into_iter().next())
                });
            }
            let captured = monitor.as_ref().and_then(|item| item.capture_image().ok());
            if let Some(image) = captured {
                let (width, height) = image.dimensions();
                let mut jpeg = Vec::new();
                if JpegEncoder::new_with_quality(&mut jpeg, 70)
                    .encode_image(&DynamicImage::ImageRgba8(image))
                    .is_ok()
                    && jpeg.len() <= 2 * 1024 * 1024
                    && app.state::<Authority>().active_peer().is_some()
                {
                    let origin = monitor
                        .as_ref()
                        .map(|monitor| (monitor.x().unwrap_or(0), monitor.y().unwrap_or(0)))
                        .unwrap_or((0, 0));
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
