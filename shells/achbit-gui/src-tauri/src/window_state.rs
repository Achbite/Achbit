use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::Manager;

/// Host-owned presentation preferences, independent of Session state.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Geometry {
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
    pub fullscreen: bool,
    // Desktop positions are physical pixels; dimensions remain logical client sizes.
    // Old preferences deliberately retain the OS-selected initial position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    position: Option<Position>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
struct Position {
    x: i32,
    y: i32,
}
impl Default for Geometry {
    fn default() -> Self {
        Self {
            width: 1500.0,
            height: 920.0,
            maximized: false,
            fullscreen: false,
            position: None,
        }
    }
}
impl Geometry {
    fn observe(
        &mut self,
        width: f64,
        height: f64,
        position: Option<Position>,
        maximized: bool,
        fullscreen: bool,
        minimized: bool,
    ) {
        // Minimized Windows report iconic coordinates and may no longer report zoomed.
        // Neither those bounds nor that transient mode replace the restore preference.
        if minimized {
            return;
        }
        self.maximized = maximized;
        self.fullscreen = fullscreen;
        if !maximized
            && !fullscreen
            && width.is_finite()
            && height.is_finite()
            && width > 0.0
            && height > 0.0
        {
            self.width = width;
            self.height = height;
            if position.is_some() {
                self.position = position;
            }
        }
    }
}
pub struct WindowState {
    path: PathBuf,
    geometry: Mutex<Geometry>,
    restoring: AtomicBool,
}
impl WindowState {
    pub fn load(path: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let geometry: Geometry = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Geometry::default(),
            Err(error) => return Err(error.into()),
        };
        if !(geometry.width.is_finite()
            && geometry.height.is_finite()
            && geometry.width > 0.0
            && geometry.height > 0.0)
        {
            return Err("Invalid saved window dimensions".into());
        }
        Ok(Self {
            path,
            geometry: Mutex::new(geometry),
            restoring: AtomicBool::new(true),
        })
    }
    pub fn geometry(&self) -> Geometry {
        self.geometry.lock().expect("window geometry lock").clone()
    }
    pub fn restore(&self, window: &tauri::WebviewWindow) -> tauri::Result<()> {
        let geometry = self.geometry();
        if let Some(saved) = geometry.position {
            let monitors = window.available_monitors()?;
            let areas: Vec<_> = monitors.iter().map(WorkArea::from).collect();
            let primary = window.primary_monitor()?.as_ref().map(WorkArea::from);
            if let Some(position) = restored_position(saved, window.outer_size()?, &areas, primary)
            {
                window.set_position(tauri::PhysicalPosition::new(position.x, position.y))?;
                // Moving to a differently scaled display can change the physical client size.
                // Apply the saved logical size on the target display, then constrain its frame.
                window.set_size(tauri::LogicalSize::new(geometry.width, geometry.height))?;
                if let Some(position) =
                    restored_position(saved, window.outer_size()?, &areas, primary)
                {
                    window.set_position(tauri::PhysicalPosition::new(position.x, position.y))?;
                }
            }
        }
        // Establish normal bounds before display modes, including the Windows restore rectangle.
        if geometry.maximized {
            window.maximize()?;
        }
        if geometry.fullscreen {
            window.set_fullscreen(true)?;
        }
        self.restoring.store(false, Ordering::SeqCst);
        window.show()?;
        window.set_focus()
    }
    pub fn observe(&self, window: &tauri::Window) -> tauri::Result<()> {
        // Creation/move/resize callbacks must not replace the pending saved geometry.
        if self.restoring.load(Ordering::SeqCst) {
            return Ok(());
        }
        // Windows sends move/resize notifications while the runtime's cached mode
        // can still describe the previous frame. Read the native mode at that boundary.
        #[cfg(windows)]
        let (maximized, minimized) = {
            use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsZoomed};
            let hwnd = window.hwnd()?;
            unsafe { (IsZoomed(hwnd).as_bool(), IsIconic(hwnd).as_bool()) }
        };
        #[cfg(not(windows))]
        let (maximized, minimized) = (window.is_maximized()?, window.is_minimized()?);
        let position = match window.outer_position() {
            Ok(position) => Some(Position {
                x: position.x,
                y: position.y,
            }),
            Err(error) => {
                // Some window managers cannot expose global coordinates. Keep other preferences.
                eprintln!("[window-state] Cannot observe window position: {error}");
                None
            }
        };
        let size = window
            .inner_size()?
            .to_logical::<f64>(window.scale_factor()?);
        let fullscreen = window.is_fullscreen()?;
        self.geometry.lock().expect("window geometry lock").observe(
            size.width,
            size.height,
            position,
            maximized,
            fullscreen,
            minimized,
        );
        Ok(())
    }
    pub fn save(&self, window: &tauri::Window) -> Result<(), Box<dyn std::error::Error>> {
        self.observe(window)?;
        persist(&self.path, &self.geometry())?;
        Ok(())
    }
}
#[derive(Clone, Copy, Debug)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}
impl From<&tauri::Monitor> for WorkArea {
    fn from(monitor: &tauri::Monitor) -> Self {
        let area = monitor.work_area();
        Self {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        }
    }
}
fn restored_position(
    saved: Position,
    size: tauri::PhysicalSize<u32>,
    areas: &[WorkArea],
    primary: Option<WorkArea>,
) -> Option<Position> {
    let overlap = |area: &WorkArea| {
        let width = (i64::from(saved.x) + i64::from(size.width))
            .min(i64::from(area.x) + i64::from(area.width))
            - i64::from(saved.x).max(i64::from(area.x));
        let height = (i64::from(saved.y) + i64::from(size.height))
            .min(i64::from(area.y) + i64::from(area.height))
            - i64::from(saved.y).max(i64::from(area.y));
        width.max(0).saturating_mul(height.max(0))
    };
    let area = areas
        .iter()
        .filter(|area| area.width > 0 && area.height > 0 && overlap(area) > 0)
        .max_by_key(|area| overlap(area))
        .copied()
        .or(primary)
        .or_else(|| areas.first().copied())?;
    let clamp = |value: i32, origin: i32, extent: u32, window: u32| {
        i64::from(value).clamp(
            i64::from(origin),
            i64::from(origin) + i64::from(extent.saturating_sub(window)),
        ) as i32
    };
    Some(Position {
        x: clamp(saved.x, area.x, area.width, size.width),
        y: clamp(saved.y, area.y, area.height, size.height),
    })
}
fn persist(path: &Path, geometry: &Geometry) -> Result<(), Box<dyn std::error::Error>> {
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Window state directory is missing")?)?;
    serde_json::to_writer(&mut file, geometry)?;
    file.flush()?;
    file.persist(path)?;
    Ok(())
}
pub fn save_main(app: &tauri::AppHandle) {
    if let (Some(window), Some(state)) = (app.get_window("main"), app.try_state::<WindowState>()) {
        if let Err(error) = state.save(&window) {
            eprintln!("[window-state] {error}");
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn display_modes_preserve_the_last_normal_size_and_round_trip() {
        let mut geometry = Geometry::default();
        geometry.observe(1280.0, 800.0, None, false, false, false);
        geometry.observe(1728.0, 1080.0, None, true, false, false);
        assert_eq!((geometry.width, geometry.height), (1280.0, 800.0));
        geometry.observe(1728.0, 1117.0, None, false, true, false);
        assert!(geometry.fullscreen);
        assert_eq!((geometry.width, geometry.height), (1280.0, 800.0));
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("window.json");
        persist(&path, &geometry).unwrap();
        assert_eq!(WindowState::load(path).unwrap().geometry(), geometry);
        geometry.observe(0.0, 0.0, None, false, false, true);
        assert_eq!((geometry.width, geometry.height), (1280.0, 800.0));
    }
    #[test]
    fn normal_position_round_trips_and_survives_display_modes() {
        let mut geometry = Geometry::default();
        let normal = Position { x: -1700, y: 80 };
        geometry.observe(1280.0, 800.0, Some(normal), false, false, false);
        geometry.observe(
            1920.0,
            1080.0,
            Some(Position { x: -1920, y: 0 }),
            true,
            false,
            false,
        );
        geometry.observe(
            0.0,
            0.0,
            Some(Position {
                x: -32000,
                y: -32000,
            }),
            false,
            false,
            true,
        );
        assert!(
            geometry.maximized,
            "minimizing must retain the prior zoomed mode"
        );
        assert_eq!(geometry.position, Some(normal));
        assert_eq!((geometry.width, geometry.height), (1280.0, 800.0));
        geometry.observe(
            1920.0,
            1080.0,
            Some(Position { x: 0, y: 0 }),
            false,
            true,
            false,
        );
        assert_eq!(geometry.position, Some(normal));
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("window.json");
        persist(&path, &geometry).unwrap();
        assert_eq!(WindowState::load(path).unwrap().geometry(), geometry);
    }
    #[test]
    fn old_preferences_without_position_remain_compatible() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("window.json");
        fs::write(
            &path,
            br#"{"width":1280,"height":800,"maximized":true,"fullscreen":false}"#,
        )
        .unwrap();
        let geometry = WindowState::load(path).unwrap().geometry();
        assert_eq!(geometry.position, None);
        assert_eq!((geometry.width, geometry.height), (1280.0, 800.0));
        assert!(geometry.maximized);
    }
    #[test]
    fn unavailable_position_does_not_erase_the_previous_normal_position() {
        let mut geometry = Geometry::default();
        let position = Position { x: 150, y: 90 };
        geometry.observe(1280.0, 800.0, Some(position), false, false, false);
        geometry.observe(1400.0, 900.0, None, false, false, false);
        assert_eq!(geometry.position, Some(position));
        assert_eq!((geometry.width, geometry.height), (1400.0, 900.0));
    }
    #[test]
    fn negative_monitor_coordinates_are_not_treated_as_offscreen() {
        let areas = [
            WorkArea {
                x: 0,
                y: 40,
                width: 1920,
                height: 1040,
            },
            WorkArea {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
            },
        ];
        let saved = Position { x: -1700, y: 80 };
        assert_eq!(
            restored_position(
                saved,
                tauri::PhysicalSize::new(1280, 800),
                &areas,
                Some(areas[0])
            ),
            Some(saved)
        );
    }
    #[test]
    fn missing_display_and_changed_work_area_keep_the_frame_accessible() {
        let primary = WorkArea {
            x: 0,
            y: 40,
            width: 1920,
            height: 1040,
        };
        let size = tauri::PhysicalSize::new(1280, 800);
        assert_eq!(
            restored_position(
                Position {
                    x: -50000,
                    y: 50000
                },
                size,
                &[primary],
                Some(primary)
            ),
            Some(Position { x: 0, y: 280 })
        );
        assert_eq!(
            restored_position(Position { x: 100, y: 0 }, size, &[primary], Some(primary)),
            Some(Position { x: 100, y: 40 })
        );
        let once = restored_position(
            Position { x: 1800, y: 900 },
            size,
            &[primary],
            Some(primary),
        )
        .unwrap();
        assert_eq!(once, Position { x: 640, y: 280 });
        assert_eq!(
            restored_position(once, size, &[primary], Some(primary)),
            Some(once),
            "restoring repeatedly must not drift by taskbar offsets"
        );
    }
    #[test]
    fn oversized_frames_keep_their_top_left_reachable_and_missing_monitors_do_not_panic() {
        let area = WorkArea {
            x: 20,
            y: 40,
            width: 1280,
            height: 720,
        };
        let size = tauri::PhysicalSize::new(2000, 1500);
        assert_eq!(
            restored_position(Position { x: 700, y: 500 }, size, &[area], Some(area)),
            Some(Position { x: 20, y: 40 })
        );
        assert_eq!(
            restored_position(Position { x: 100, y: 100 }, size, &[], None),
            None
        );
    }
    #[test]
    fn only_absent_preferences_use_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("window.json");
        assert_eq!(
            WindowState::load(path.clone()).unwrap().geometry(),
            Geometry::default()
        );
        fs::write(&path, b"broken").unwrap();
        assert!(WindowState::load(path).is_err());
    }
}
