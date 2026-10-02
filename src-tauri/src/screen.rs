use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;
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
    low_data: AtomicBool,
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

fn frame_signature(image: &image::RgbaImage, cursor: (i32, i32)) -> u64 {
    let mut hash = DefaultHasher::new();
    hash.write_u32(image.width());
    hash.write_u32(image.height());
    hash.write_i32(cursor.0);
    hash.write_i32(cursor.1);
    hash.write(image.as_raw());
    hash.finish()
}

fn scaled_cursor(value: i32, original: u32, reduced: u32) -> i32 {
    if value < 0 || original == 0 || i64::from(value) >= i64::from(original) {
        return -1;
    }
    (i64::from(value) * i64::from(reduced) / i64::from(original)) as i32
}

impl FrameStore {
    pub fn latest(&self, since: u64) -> Option<FrameResult> {
        if self.paused() {
            return None;
        }
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
            if self.paused() {
                return;
            }
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

    pub fn set_low_data(&self, enabled: bool) {
        self.low_data.store(enabled, Ordering::Relaxed);
    }

    fn low_data(&self) -> bool {
        self.low_data.load(Ordering::Relaxed)
    }
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let mut monitor: Option<Monitor> = None;
        let mouse = Enigo::new(&Settings::default()).ok();
        let mut last_signature = None;
        let mut previous_low_data = false;
        let mut idle = false;
        loop {
            if app.state::<Authority>().active_peer().is_none()
                || app.state::<FrameStore>().paused()
            {
                last_signature = None;
                idle = false;
                thread::sleep(Duration::from_millis(250));
                continue;
            }
            let started = Instant::now();
            let low_data = app.state::<FrameStore>().low_data();
            if low_data != previous_low_data {
                last_signature = None;
                idle = false;
                previous_low_data = low_data;
            }
            if monitor.is_none() {
                monitor = primary_monitor();
            }
            let captured = monitor.as_ref().and_then(capture);
            if let Some(image) = captured {
                let (original_width, original_height) = image.dimensions();
                let origin = monitor.as_ref().map(monitor_origin).unwrap_or((0, 0));
                let cursor = mouse
                    .as_ref()
                    .and_then(|mouse| mouse.location().ok())
                    .map(|(x, y)| (x - origin.0, y - origin.1))
                    .unwrap_or((-1, -1));
                let image = if low_data && (original_width > 960 || original_height > 540) {
                    let scale =
                        (960.0 / f64::from(original_width)).min(540.0 / f64::from(original_height));
                    let width = (f64::from(original_width) * scale).round().max(1.0) as u32;
                    let height = (f64::from(original_height) * scale).round().max(1.0) as u32;
                    image::imageops::resize(
                        &image,
                        width,
                        height,
                        image::imageops::FilterType::Triangle,
                    )
                } else {
                    image
                };
                let (width, height) = image.dimensions();
                let cursor = (
                    scaled_cursor(cursor.0, original_width, width),
                    scaled_cursor(cursor.1, original_height, height),
                );
                let signature = low_data.then(|| frame_signature(&image, cursor));
                idle = low_data && signature == last_signature;
                if !idle {
                    let mut jpeg = Vec::new();
                    if JpegEncoder::new_with_quality(&mut jpeg, if low_data { 50 } else { 70 })
                        .encode_image(&DynamicImage::ImageRgba8(image))
                        .is_ok()
                        && jpeg.len() <= 2 * 1024 * 1024
                        && app.state::<Authority>().active_peer().is_some()
                        && !app.state::<FrameStore>().paused()
                    {
                        let frame = Frame {
                            jpeg_base64: base64::engine::general_purpose::STANDARD.encode(jpeg),
                            width,
                            height,
                            cursor_x: cursor.0,
                            cursor_y: cursor.1,
                        };
                        app.state::<FrameStore>().put(frame);
                        last_signature = signature;
                    }
                }
            } else {
                monitor = None;
                last_signature = None;
            }
            let elapsed = started.elapsed();
            let interval = if low_data {
                Duration::from_millis(if idle { 500 } else { 100 })
            } else {
                Duration::from_millis(33)
            };
            if elapsed < interval {
                thread::sleep(interval - elapsed);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paused_capture_does_not_replay_old_frames() {
        let frames = FrameStore::default();
        let frame = Frame {
            jpeg_base64: String::new(),
            width: 1,
            height: 1,
            cursor_x: 0,
            cursor_y: 0,
        };
        frames.put(frame.clone());
        assert!(frames.latest(0).is_some());
        frames.set_paused(true);
        frames.put(frame.clone());
        assert!(frames.latest(0).is_none());
        frames.set_paused(false);
        assert!(frames.latest(0).is_none());
        frames.put(frame);
        assert!(frames.latest(1).is_some());
    }

    #[test]
    fn low_data_signature_tracks_pixels_and_pointer() {
        let mut image = image::RgbaImage::new(2, 2);
        let first = frame_signature(&image, (1, 1));
        assert_eq!(first, frame_signature(&image, (1, 1)));
        assert_ne!(first, frame_signature(&image, (0, 1)));
        image.put_pixel(1, 1, image::Rgba([255, 0, 0, 255]));
        assert_ne!(first, frame_signature(&image, (1, 1)));
        assert_eq!(scaled_cursor(100, 200, 100), 50);
        assert_eq!(scaled_cursor(-1, 200, 100), -1);
    }
}
