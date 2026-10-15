//! Exact HWND capture on a dedicated WinRT owner thread. Frame callbacks retain
//! only the latest CPU image; stopping joins the owner and closes GPU resources.
use super::{
    capture::{self, Image},
    desktop::{self, Window},
};
use crate::protocol;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Condvar, Mutex,
};
use std::thread::JoinHandle;
use std::time::Duration;
use windows::core::{IInspectable, Interface};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat};
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

static FRAME_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub struct Frame {
    pub image: Image,
    pub captured_at: String,
    pub sequence: u64,
    pub window: Window,
}

#[derive(Default)]
struct Latest {
    frame: Option<Arc<Frame>>,
    stopped: bool,
    error: Option<String>,
}

impl Latest {
    fn publish(&mut self, frame: Frame) {
        if !self.stopped {
            self.frame = Some(Arc::new(frame));
        }
    }
    fn stop(&mut self, error: Option<String>) {
        self.stopped = true;
        self.frame = None;
        if self.error.is_none() {
            self.error = error;
        }
    }
}

#[derive(Default)]
struct State {
    latest: Mutex<Latest>,
    changed: Condvar,
}

impl State {
    fn stop(&self, error: Option<String>) {
        if let Ok(mut state) = self.latest.lock() {
            state.stop(error);
        }
        self.changed.notify_all();
    }
}

pub struct Capture {
    state: Arc<State>,
    owner: Mutex<Option<JoinHandle<()>>>,
}

impl Capture {
    pub fn start(window: &Window, limit: u32) -> Result<Self, String> {
        let state = Arc::new(State::default());
        let worker_state = state.clone();
        let window = window.clone();
        let owner = std::thread::Builder::new()
            .name("computer-wgc".into())
            .spawn(move || {
                let result = capture_window(&window, limit, &worker_state);
                if let Err(error) = result {
                    worker_state.stop(Some(format!("WGC: {error}")));
                }
            })
            .map_err(|error| error.to_string())?;
        let capture = Self {
            state,
            owner: Mutex::new(Some(owner)),
        };
        capture.first_frame()?;
        Ok(capture)
    }

    fn first_frame(&self) -> Result<Arc<Frame>, String> {
        let state = self
            .state
            .latest
            .lock()
            .map_err(|_| "WGC frame state unavailable")?;
        let (state, _) = self
            .state
            .changed
            .wait_timeout_while(state, Duration::from_secs(4), |state| {
                state.frame.is_none() && !state.stopped
            })
            .map_err(|_| "WGC frame state unavailable")?;
        if let Some(error) = &state.error {
            return Err(error.clone());
        }
        state
            .frame
            .clone()
            .ok_or_else(|| "WGC did not produce a frame within 4 seconds".into())
    }

    pub fn latest(&self) -> Result<Option<Arc<Frame>>, String> {
        let state = self
            .state
            .latest
            .lock()
            .map_err(|_| "WGC frame state unavailable")?;
        if let Some(error) = &state.error {
            return Err(error.clone());
        }
        if state.stopped {
            return Err("WGC capture stopped".into());
        }
        Ok(state.frame.clone())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.state.stop(None);
        if let Some(owner) = self
            .owner
            .lock()
            .map_err(|_| "WGC owner unavailable")?
            .take()
        {
            owner
                .join()
                .map_err(|_| "WGC capture thread panicked during shutdown")?;
        }
        Ok(())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("{error}");
        }
    }
}

/// A tool observation acquires a new frame, independently of the presentation
/// cache. A static preview is never relabelled as a screenshot taken after input.
pub fn snapshot(window: &Window) -> Result<Arc<Frame>, String> {
    Capture::start(window, protocol::IMAGE_EDGE_LIMIT)?.first_frame()
}

pub fn same_window(a: &Window, b: &Window) -> bool {
    a.id == b.id && a.pid == b.pid && a.class == b.class && a.app == b.app
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

struct Session {
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    arrived: Option<i64>,
    closed: Option<i64>,
}
impl Drop for Session {
    fn drop(&mut self) {
        if let Some(token) = self.arrived {
            let _ = self.pool.RemoveFrameArrived(token);
        }
        if let Some(token) = self.closed {
            let _ = self.item.RemoveClosed(token);
        }
        if let Err(error) = self.session.Close() {
            eprintln!("WGC session close failed: {error}");
        }
        if let Err(error) = self.pool.Close() {
            eprintln!("WGC frame pool close failed: {error}");
        }
    }
}

fn capture_window(window: &Window, limit: u32, state: &Arc<State>) -> Result<(), String> {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|e| e.to_string())?;
    let _apartment = Apartment;
    if !GraphicsCaptureSession::IsSupported().map_err(|e| e.to_string())? {
        return Err("Windows Graphics Capture is unavailable on this system".into());
    }
    let factory: IGraphicsCaptureItemInterop =
        windows::core::factory::<GraphicsCaptureItem, _>().map_err(|e| e.to_string())?;
    let item: GraphicsCaptureItem =
        unsafe { factory.CreateForWindow(window.hwnd()) }.map_err(|e| e.to_string())?;
    let (mut device, mut context) = (None, None);
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(|e| e.to_string())?;
    let device = device.ok_or("D3D11 returned no device")?;
    let context = context.ok_or("D3D11 returned no context")?;
    let dxgi: IDXGIDevice = device.cast().map_err(|e| e.to_string())?;
    let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
        .and_then(|value| value.cast())
        .map_err(|e| e.to_string())?;
    let size = item.Size().map_err(|e| e.to_string())?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        size,
    )
    .map_err(|e| e.to_string())?;
    let session = pool
        .CreateCaptureSession(&item)
        .map_err(|e| e.to_string())?;
    let mut owned = Session {
        item,
        pool,
        session,
        arrived: None,
        closed: None,
    };
    // Cursor capture is optional on older WGC systems. The action pointer is
    // independent feedback and does not depend on this extension.
    match owned.session.SetIsCursorCaptureEnabled(false) {
        Ok(()) => {}
        Err(error) if error.code().0 == 0x80004002_u32 as i32 => {} // E_NOINTERFACE
        Err(error) => return Err(error.to_string()),
    }
    let processor = Mutex::new(Processor {
        device,
        context,
        size,
        staging: None,
    });
    let callback_state = state.clone();
    let target = window.clone();
    owned.arrived = Some(
        owned
            .pool
            .FrameArrived(
                &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(
                    move |pool, _| {
                        let result = (|| -> Result<(), String> {
                            let pool = pool.as_ref().ok_or("WGC frame event has no pool")?;
                            let mut processor =
                                processor.lock().map_err(|_| "WGC processor unavailable")?;
                            if callback_state
                                .latest
                                .lock()
                                .map_err(|_| "WGC frame state unavailable")?
                                .stopped
                            {
                                return Ok(());
                            }
                            if let Some(frame) = processor.frame(pool, &target, limit)? {
                                callback_state
                                    .latest
                                    .lock()
                                    .map_err(|_| "WGC frame state unavailable")?
                                    .publish(frame);
                                callback_state.changed.notify_all();
                            }
                            Ok(())
                        })();
                        if let Err(error) = result {
                            callback_state.stop(Some(format!("WGC frame: {error}")));
                        }
                        Ok(())
                    },
                ),
            )
            .map_err(|e| e.to_string())?,
    );
    let closed_state = state.clone();
    owned.closed = Some(
        owned
            .item
            .Closed(
                &TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| {
                    closed_state.stop(Some("The captured window closed".into()));
                    Ok(())
                }),
            )
            .map_err(|e| e.to_string())?,
    );
    owned.session.StartCapture().map_err(|e| e.to_string())?;
    loop {
        let latest = state
            .latest
            .lock()
            .map_err(|_| "WGC frame state unavailable")?;
        if latest.stopped {
            break;
        }
        let (latest, _) = state
            .changed
            .wait_timeout(latest, Duration::from_millis(100))
            .map_err(|_| "WGC frame state unavailable")?;
        if latest.stopped {
            break;
        }
        drop(latest);
        let current = desktop::snapshot(window.id)?;
        if !same_window(window, &current) {
            return Err("Captured window identity changed".into());
        }
    }
    Ok(())
}

struct Processor {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    size: SizeInt32,
    staging: Option<ID3D11Texture2D>,
}

impl Processor {
    fn frame(
        &mut self,
        pool: &Direct3D11CaptureFramePool,
        target: &Window,
        limit: u32,
    ) -> Result<Option<Frame>, String> {
        let frame = pool.TryGetNextFrame().map_err(|e| e.to_string())?;
        let mut resized = false;
        let result = (|| -> Result<Option<Frame>, String> {
            let size = frame.ContentSize().map_err(|e| e.to_string())?;
            if size.Width <= 0 || size.Height <= 0 || size.Width > 16384 || size.Height > 16384 {
                return Err("WGC frame has invalid dimensions".into());
            }
            if size != self.size {
                resized = true;
                self.size = size;
                self.staging = None;
                return Ok(None);
            }
            let window = desktop::snapshot(target.id)?;
            if !same_window(target, &window) {
                return Err("Captured window identity changed".into());
            }
            // The HWND can resize before its next WGC frame arrives. Do not
            // attach the new coordinate space to pixels from the old geometry.
            if (f64::from(size.Width), f64::from(size.Height))
                != (window.bounds.width, window.bounds.height)
            {
                return Ok(None);
            }
            let access: IDirect3DDxgiInterfaceAccess = frame
                .Surface()
                .and_then(|surface| surface.cast())
                .map_err(|e| e.to_string())?;
            let texture: ID3D11Texture2D =
                unsafe { access.GetInterface() }.map_err(|e| e.to_string())?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { texture.GetDesc(&mut desc) };
            if size.Width as u32 > desc.Width || size.Height as u32 > desc.Height {
                return Ok(None);
            }
            if self.staging.is_none() {
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                desc.MiscFlags = 0;
                unsafe {
                    self.device
                        .CreateTexture2D(&desc, None, Some(&mut self.staging))
                }
                .map_err(|e| e.to_string())?;
            }
            let staging = self
                .staging
                .as_ref()
                .ok_or("D3D11 returned no staging texture")?;
            unsafe { self.context.CopyResource(staging, &texture) };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            unsafe {
                self.context
                    .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            }
            .map_err(|e| e.to_string())?;
            let image = read_pixels(&mapped, size);
            unsafe { self.context.Unmap(staging, 0) };
            let image = image?;
            let dimensions = protocol::scaled_size(image.width, image.height, limit);
            let image = capture::reduce(&image, dimensions.0, dimensions.1);
            Ok(Some(Frame {
                image,
                captured_at: protocol::timestamp_millis()?,
                sequence: FRAME_SEQUENCE.fetch_add(1, Ordering::Relaxed),
                window,
            }))
        })();
        let closed = frame.Close().map_err(|e| e.to_string());
        drop(frame);
        let result = result?;
        closed?;
        // Recreate only after returning the old frame to the pool.
        if resized {
            let dxgi: IDXGIDevice = self.device.cast().map_err(|e| e.to_string())?;
            let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
                .and_then(|value| value.cast())
                .map_err(|e| e.to_string())?;
            pool.Recreate(
                &winrt,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                self.size,
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(result)
    }
}

fn read_pixels(mapped: &D3D11_MAPPED_SUBRESOURCE, size: SizeInt32) -> Result<Image, String> {
    let (width, height) = (size.Width as usize, size.Height as usize);
    if mapped.pData.is_null() || (mapped.RowPitch as usize) < width * 4 {
        return Err("WGC texture has invalid row storage".into());
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(mapped.pData.cast::<u8>(), mapped.RowPitch as usize * height)
    };
    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in bytes.chunks_exact(mapped.RowPitch as usize) {
        for pixel in row[..width * 4].chunks_exact(4) {
            rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
    }
    Ok(Image {
        width: width as u32,
        height: height as u32,
        rgb,
    })
}

#[cfg(test)]
#[path = "wgc_tests.rs"]
mod tests;
