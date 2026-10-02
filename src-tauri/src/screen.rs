use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use enigo::{Enigo, Mouse, Settings};
use image::codecs::jpeg::JpegEncoder;
use image::DynamicImage;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use xcap::Monitor;

use crate::authority::Authority;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    jpeg_base64: String,
    width: u32,
    height: u32,
    cursor_x: i32,
    cursor_y: i32,
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
                    let _ = app.emit("screen-frame", frame);
                }
            } else {
                monitor = None;
            }
            let elapsed = started.elapsed();
            if elapsed < Duration::from_millis(67) {
                thread::sleep(Duration::from_millis(67) - elapsed);
            }
        }
    });
}
