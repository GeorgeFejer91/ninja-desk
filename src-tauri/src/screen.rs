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
    peer: String,
    display_revision: u64,
    jpeg_base64: String,
    width: u32,
    height: u32,
    cursor_x: i32,
    cursor_y: i32,
}

#[derive(Default)]
pub struct FrameStore {
    frame: Mutex<(u64, Option<Frame>, Option<Instant>)>,
    paused: AtomicBool,
    low_data: AtomicBool,
}

#[derive(Serialize)]
pub struct FrameResult {
    seq: u64,
    payload: Frame,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameStats {
    pub sequence: u64,
    pub last_frame_age_ms: Option<u64>,
    pub paused: bool,
    pub low_data: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Display {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

impl Display {
    pub fn point(self, x: u16, y: u16) -> (i32, i32) {
        (
            (i64::from(self.x) + i64::from(x) * i64::from(self.width - 1) / 65_535) as i32,
            (i64::from(self.y) + i64::from(y) * i64::from(self.height - 1) / 65_535) as i32,
        )
    }
}

#[cfg(target_os = "linux")]
fn display_info(monitor: &Monitor) -> Option<Display> {
    let info = monitor.display_info;
    Some(Display {
        id: info.id,
        x: info.x,
        y: info.y,
        width: i32::try_from(info.width).ok()?,
        height: i32::try_from(info.height).ok()?,
        primary: info.is_primary,
    })
}

#[cfg(not(target_os = "linux"))]
fn display_info(monitor: &Monitor) -> Option<Display> {
    Some(Display {
        id: monitor.id().ok()?,
        x: monitor.x().ok()?,
        y: monitor.y().ok()?,
        width: i32::try_from(monitor.width().ok()?).ok()?,
        height: i32::try_from(monitor.height().ok()?).ok()?,
        primary: monitor.is_primary().ok()?,
    })
}

pub fn displays() -> Result<Vec<Display>, String> {
    let mut displays: Vec<_> = Monitor::all()
        .map_err(|_| "display_unavailable")?
        .iter()
        .filter_map(display_info)
        .filter(|display| {
            display.width > 0
                && display.height > 0
                && i64::from(display.x) + i64::from(display.width) <= i64::from(i32::MAX)
                && i64::from(display.y) + i64::from(display.height) <= i64::from(i32::MAX)
        })
        .collect();
    displays.sort_by_key(|display| (!display.primary, display.x, display.y, display.id));
    if displays.is_empty() || displays.len() > 16 {
        return Err("display_unavailable".into());
    }
    Ok(displays)
}

pub fn next_display(displays: &[Display], current: Display) -> Result<(Display, usize), String> {
    let index = displays
        .iter()
        .position(|display| *display == current)
        .ok_or("display_changed")?;
    let next = (index + 1) % displays.len();
    Ok((displays[next], next))
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

    pub fn stats(&self) -> FrameStats {
        let state = self.frame.lock().ok();
        FrameStats {
            sequence: state.as_ref().map_or(0, |state| state.0),
            last_frame_age_ms: state
                .as_ref()
                .and_then(|state| state.2)
                .map(|at| at.elapsed().as_millis() as u64),
            paused: self.paused(),
            low_data: self.low_data(),
        }
    }

    fn put(&self, frame: Frame) {
        if let Ok(mut state) = self.frame.lock() {
            if self.paused() {
                return;
            }
            state.0 = state.0.wrapping_add(1);
            state.1 = Some(frame);
            state.2 = Some(Instant::now());
        }
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
        if let Ok(mut state) = self.frame.lock() {
            state.1 = None;
            state.2 = None;
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
        let mut selection = None;
        let mut last_monitor_check = Instant::now();
        let mouse = Enigo::new(&Settings::default()).ok();
        let mut last_signature = None;
        let mut previous_low_data = false;
        let mut idle = false;
        loop {
            let selected = app.state::<Authority>().active_display();
            if selected.is_none() || app.state::<FrameStore>().paused() {
                last_signature = None;
                idle = false;
                thread::sleep(Duration::from_millis(250));
                continue;
            }
            let Some(selected) = selected else {
                continue;
            };
            if selection.as_ref() != Some(&selected) {
                monitor = Monitor::all().ok().and_then(|monitors| {
                    monitors
                        .into_iter()
                        .find(|monitor| display_info(monitor) == Some(selected.1))
                });
                selection = Some(selected.clone());
                last_signature = None;
                idle = false;
                last_monitor_check = Instant::now();
            } else if last_monitor_check.elapsed() >= Duration::from_secs(1) {
                // Check topology in the capture worker, never on each mouse move.
                if !displays().is_ok_and(|displays| displays.contains(&selected.1)) {
                    app.state::<Authority>().disconnect(&selected.0);
                    continue;
                }
                last_monitor_check = Instant::now();
            }
            let started = Instant::now();
            let low_data = app.state::<FrameStore>().low_data();
            if low_data != previous_low_data {
                last_signature = None;
                idle = false;
                previous_low_data = low_data;
            }
            let captured = monitor.as_ref().and_then(capture);
            if let Some(image) = captured {
                let (original_width, original_height) = image.dimensions();
                if original_width != selected.1.width as u32
                    || original_height != selected.1.height as u32
                {
                    app.state::<Authority>().disconnect(&selected.0);
                    continue;
                }
                let origin = (selected.1.x, selected.1.y);
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
                        && app.state::<Authority>().active_display().as_ref() == Some(&selected)
                        && !app.state::<FrameStore>().paused()
                    {
                        let frame = Frame {
                            peer: selected.0.clone(),
                            display_revision: selected.2,
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
                app.state::<Authority>().disconnect(&selected.0);
                monitor = None;
                selection = None;
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
    fn cycles_monitors_and_maps_negative_and_vertical_origins() {
        let primary = Display {
            id: 1,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            primary: true,
        };
        let left = Display {
            id: 2,
            x: -2560,
            y: -200,
            width: 2560,
            height: 1440,
            primary: false,
        };
        let above = Display {
            id: 3,
            x: 100,
            y: -1080,
            width: 1920,
            height: 1080,
            primary: false,
        };
        assert_eq!(
            next_display(&[primary, left, above], primary).unwrap(),
            (left, 1)
        );
        assert_eq!(
            next_display(&[primary, left, above], above).unwrap(),
            (primary, 0)
        );
        assert_eq!(next_display(&[primary], primary).unwrap(), (primary, 0));
        assert!(next_display(&[], primary).is_err());
        assert_eq!(
            next_display(&[primary], left).unwrap_err(),
            "display_changed"
        );
        assert_eq!(left.point(0, 0), (-2560, -200));
        assert_eq!(left.point(65535, 65535), (-1, 1239));
        assert_eq!(above.point(65535, 65535), (2019, -1));
    }

    #[test]
    fn paused_capture_does_not_replay_old_frames() {
        let frames = FrameStore::default();
        let frame = Frame {
            peer: "test".into(),
            display_revision: 0,
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
