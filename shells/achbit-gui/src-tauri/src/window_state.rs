use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

/// Host-owned presentation preferences, independent of Session state.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Geometry {
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
    pub fullscreen: bool,
}
impl Default for Geometry {
    fn default() -> Self {
        Self {
            width: 1500.0,
            height: 920.0,
            maximized: false,
            fullscreen: false,
        }
    }
}
impl Geometry {
    fn observe(
        &mut self,
        width: f64,
        height: f64,
        maximized: bool,
        fullscreen: bool,
        minimized: bool,
    ) {
        self.maximized = maximized;
        self.fullscreen = fullscreen;
        if !maximized && !fullscreen && !minimized && width > 0.0 && height > 0.0 {
            self.width = width;
            self.height = height;
        }
    }
}
pub struct WindowState {
    path: PathBuf,
    geometry: Mutex<Geometry>,
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
        })
    }
    pub fn geometry(&self) -> Geometry {
        self.geometry.lock().expect("window geometry lock").clone()
    }
    pub fn observe(&self, window: &tauri::Window) -> tauri::Result<()> {
        let size = window
            .inner_size()?
            .to_logical::<f64>(window.scale_factor()?);
        self.geometry.lock().expect("window geometry lock").observe(
            size.width,
            size.height,
            window.is_maximized()?,
            window.is_fullscreen()?,
            window.is_minimized()?,
        );
        Ok(())
    }
    pub fn save(&self, window: &tauri::Window) -> Result<(), Box<dyn std::error::Error>> {
        self.observe(window)?;
        persist(&self.path, &self.geometry())?;
        Ok(())
    }
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
        geometry.observe(1280.0, 800.0, false, false, false);
        geometry.observe(1728.0, 1080.0, true, false, false);
        assert_eq!((geometry.width, geometry.height), (1280.0, 800.0));
        geometry.observe(1728.0, 1117.0, false, true, false);
        assert!(geometry.fullscreen);
        assert_eq!((geometry.width, geometry.height), (1280.0, 800.0));
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("window.json");
        persist(&path, &geometry).unwrap();
        assert_eq!(WindowState::load(path).unwrap().geometry(), geometry);
        geometry.observe(0.0, 0.0, false, false, true);
        assert_eq!((geometry.width, geometry.height), (1280.0, 800.0));
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
