//! Pixel capture with GDI. Windows render through PrintWindow, so covered windows
//! are captured without activation; displays copy the composed desktop.
use super::desktop::{self, Window};
use crate::protocol::{self, Bounds};
use std::ffi::c_void;
use std::io::Write;
use std::path::{Path, PathBuf};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, MonitorFromWindow,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, DIB_RGB_COLORS, HDC,
    MONITOR_DEFAULTTONEAREST, ROP_CODE, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, GetWindowRect, SM_CXSCREEN, SM_CYSCREEN,
};

/// PW_RENDERFULLCONTENT: include DirectComposition and DirectX content.
const RENDER_FULL_CONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

pub struct Image {
    pub width: u32,
    pub height: u32,
    /// Tightly packed RGB rows.
    pub rgb: Vec<u8>,
}

impl Image {
    fn is_blank(&self) -> bool {
        self.rgb.iter().all(|value| *value == 0)
    }
}

/// A 32-bit top-down DIB selected into a memory DC; released on drop.
struct Surface {
    screen: HDC,
    memory: HDC,
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
    previous: windows::Win32::Graphics::Gdi::HGDIOBJ,
    bits: *mut c_void,
    width: i32,
    height: i32,
}

impl Surface {
    fn new(width: i32, height: i32) -> Result<Self, String> {
        if width <= 0 || height <= 0 || width > 16384 || height > 16384 {
            return Err("Capture area has invalid dimensions".into());
        }
        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return Err("Cannot open the desktop device context".into());
            }
            let memory = CreateCompatibleDC(Some(screen));
            if memory.is_invalid() {
                ReleaseDC(None, screen);
                return Err("Cannot create a capture device context".into());
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: 0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap =
                match CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
                    Ok(bitmap) if !bits.is_null() => bitmap,
                    Ok(bitmap) => {
                        let _ = DeleteObject(bitmap.into());
                        let _ = DeleteDC(memory);
                        ReleaseDC(None, screen);
                        return Err("Capture bitmap has no pixel storage".into());
                    }
                    Err(error) => {
                        let _ = DeleteDC(memory);
                        ReleaseDC(None, screen);
                        return Err(format!("Cannot allocate capture bitmap: {error}"));
                    }
                };
            let previous = SelectObject(memory, bitmap.into());
            Ok(Self {
                screen,
                memory,
                bitmap,
                previous,
                bits,
                width,
                height,
            })
        }
    }

    /// Copies a sub-rectangle of the BGRA surface as RGB.
    fn rgb(&self, left: i32, top: i32, width: i32, height: i32) -> Image {
        let pixels = unsafe {
            std::slice::from_raw_parts(
                self.bits as *const u8,
                (self.width * self.height * 4) as usize,
            )
        };
        let mut rgb = Vec::with_capacity((width * height * 3) as usize);
        for y in top..top + height {
            let row = &pixels[(y * self.width * 4) as usize..((y + 1) * self.width * 4) as usize];
            for x in left..left + width {
                let pixel = &row[(x * 4) as usize..(x * 4 + 3) as usize];
                rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
            }
        }
        Image {
            width: width as u32,
            height: height as u32,
            rgb,
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.memory, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.memory);
            ReleaseDC(None, self.screen);
        }
    }
}

fn screen_area(bounds: Bounds) -> Result<Image, String> {
    let (width, height) = (bounds.width as i32, bounds.height as i32);
    let surface = Surface::new(width, height)?;
    unsafe {
        BitBlt(
            surface.memory,
            0,
            0,
            width,
            height,
            Some(surface.screen),
            bounds.x as i32,
            bounds.y as i32,
            ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0),
        )
    }
    .map_err(|error| format!("Desktop capture failed: {error}"))?;
    Ok(surface.rgb(0, 0, width, height))
}

pub fn primary_display() -> Result<Image, String> {
    let (width, height) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    screen_area(Bounds {
        x: 0.0,
        y: 0.0,
        width: width as f64,
        height: height as f64,
    })
}

/// DPI-virtualized windows (unaware or system aware on another scale) render
/// PrintWindow output in their own logical pixels, not physical desktop pixels.
fn render_scale(hwnd: windows::Win32::Foundation::HWND) -> f64 {
    unsafe {
        let window = GetDpiForWindow(hwnd);
        let (mut x, mut y) = (0u32, 0u32);
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if window == 0
            || GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y).is_err()
            || x == 0
        {
            return 1.0;
        }
        window as f64 / x as f64
    }
}

/// Captures the window's visible frame. PrintWindow renders covered windows; a
/// blank result of the frontmost window falls back to its composed screen pixels.
/// The image covers exactly the frame; coordinates map proportionally to it.
pub fn window(window: &Window) -> Result<Image, String> {
    let hwnd = window.hwnd();
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .map_err(|error| format!("Cannot read window rectangle: {error}"))?;
    let scale = render_scale(hwnd);
    let logical = |value: f64| (value * scale).round() as i32;
    let surface = Surface::new(
        logical((rect.right - rect.left) as f64),
        logical((rect.bottom - rect.top) as f64),
    )?;
    if !unsafe { PrintWindow(hwnd, surface.memory, RENDER_FULL_CONTENT) }.as_bool() {
        return Err("Window capture failed (PrintWindow); observe again".into());
    }
    // GetWindowRect includes the invisible resize border; crop to the DWM frame.
    let left = logical(window.bounds.x - rect.left as f64).clamp(0, surface.width - 1);
    let top = logical(window.bounds.y - rect.top as f64).clamp(0, surface.height - 1);
    let width = logical(window.bounds.width).clamp(1, surface.width - left);
    let height = logical(window.bounds.height).clamp(1, surface.height - top);
    let image = surface.rgb(left, top, width, height);
    if image.is_blank() && desktop::foreground_is(window) {
        return screen_area(window.bounds);
    }
    Ok(image)
}

/// Area-averaging reduction; the archived pixels are exactly what the model receives.
fn reduce(image: &Image, width: u32, height: u32) -> Image {
    if (width, height) == (image.width, image.height) {
        return Image {
            width,
            height,
            rgb: image.rgb.clone(),
        };
    }
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        let (y0, y1) = span(y, height, image.height);
        for x in 0..width {
            let (x0, x1) = span(x, width, image.width);
            let mut sum = [0u64; 3];
            for sy in y0..y1 {
                let row = (sy * image.width * 3) as usize;
                for sx in x0..x1 {
                    let index = row + (sx * 3) as usize;
                    for (total, value) in sum.iter_mut().zip(&image.rgb[index..index + 3]) {
                        *total += *value as u64;
                    }
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as u64;
            rgb.extend(sum.iter().map(|value| ((value + count / 2) / count) as u8));
        }
    }
    Image { width, height, rgb }
}

fn span(index: u32, target: u32, source: u32) -> (u32, u32) {
    let start = (index as u64 * source as u64 / target as u64) as u32;
    let end = (((index + 1) as u64 * source as u64 / target as u64) as u32).max(start + 1);
    (start, end.min(source))
}

pub fn save(image: &Image, directory: &Path, id: &str) -> Result<(PathBuf, u32, u32), String> {
    let (width, height) =
        protocol::scaled_size(image.width, image.height, protocol::IMAGE_EDGE_LIMIT);
    let image = reduce(image, width, height);
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut encoded, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&image.rgb)
            .map_err(|error| error.to_string())?;
    }
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!("{id}.png"));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|error| format!("Cannot archive capture {}: {error}", path.display()))?;
    file.write_all(&encoded)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    Ok((path, width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduction_averages_complete_source_areas() {
        let image = Image {
            width: 4,
            height: 2,
            rgb: [[0u8, 0, 0], [255, 255, 255], [10, 20, 30], [10, 20, 30]]
                .iter()
                .flatten()
                .copied()
                .cycle()
                .take(4 * 2 * 3)
                .collect(),
        };
        let reduced = reduce(&image, 2, 1);
        assert_eq!(reduced.rgb, vec![128, 128, 128, 10, 20, 30]);
        assert_eq!(span(0, 3, 10), (0, 3));
        assert_eq!(span(2, 3, 10), (6, 10));
    }

    #[test]
    fn primary_display_is_archived_within_the_edge_limit() {
        let directory = std::env::temp_dir().join(format!("deepcode-cu-{}", std::process::id()));
        let image = primary_display().unwrap();
        let (path, width, height) = save(&image, &directory, "capture-test").unwrap();
        assert!(width.max(height) <= protocol::IMAGE_EDGE_LIMIT);
        assert_eq!(&std::fs::read(&path).unwrap()[1..4], b"PNG");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
