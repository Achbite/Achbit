//! Page layout policy, separate from the Reader's available display rectangle.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum Viewport {
    Adaptive {},
    Fixed { width: u32, height: u32 },
}
impl Default for Viewport {
    fn default() -> Self {
        Self::Fixed {
            width: 1280,
            height: 800,
        }
    }
}
impl Viewport {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let viewport: Self = serde_json::from_value(value.clone())
            .map_err(|error| format!("browser_viewport_invalid: {error}"))?;
        if let Self::Fixed { width, height } = viewport {
            if !(1..=8192).contains(&width) || !(1..=8192).contains(&height) {
                return Err("browser_viewport_invalid: width and height must be integers from 1 to 8192 CSS pixels".into());
            }
        }
        Ok(viewport)
    }
    /// Top-aligned, horizontally centered; expanding only changes display scale.
    pub fn fit(self, [x, y, width, height]: [f64; 4]) -> ([f64; 4], f64) {
        match self {
            Self::Adaptive {} => ([x, y, width, height], 1.0),
            Self::Fixed {
                width: w,
                height: h,
            } => {
                let scale = (width / f64::from(w)).min(height / f64::from(h)).min(1.0);
                let (w, h) = (f64::from(w) * scale, f64::from(h) * scale);
                ([x + (width - w) / 2.0, y, w, h], scale)
            }
        }
    }
    pub fn initial_size(self) -> (f64, f64) {
        match self {
            Self::Fixed { width, height } => (f64::from(width), f64::from(height)),
            Self::Adaptive {} => (1280.0, 800.0),
        }
    }
}
