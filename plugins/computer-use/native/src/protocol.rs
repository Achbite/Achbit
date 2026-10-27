//! Platform-neutral helper protocol: launch arguments, Host binding, resource
//! identity and screenshot coordinates. No platform I/O lives here.
use serde_json::Value;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};

static RESOURCE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Focus changes require an explicit request, including app-only observations.
pub fn foreground_requested(input: &Value) -> bool {
    input["mode"] == "foreground"
}

/// Observations older than this must be refreshed before any action.
pub const OBSERVATION_LIFETIME_SECONDS: u64 = 120;
/// Longest edge of every archived screenshot supplied to the model.
pub const IMAGE_EDGE_LIMIT: u32 = 1600;

pub struct Launch {
    pub endpoint: SocketAddr,
    pub token: String,
    pub host: String,
}

/// The shared Host is the only launcher: `--connect <loopback> --token <t> --host <id>`.
pub fn launch_arguments(arguments: &[String]) -> Result<Launch, String> {
    if arguments.len() != 7
        || arguments[1] != "--connect"
        || arguments[3] != "--token"
        || arguments[5] != "--host"
    {
        return Err("Launch this component through the Achbit Host.".into());
    }
    let endpoint: SocketAddr = arguments[2].parse().map_err(|_| "Invalid Host endpoint")?;
    if !endpoint.ip().is_loopback() {
        return Err("Host endpoint must be local".into());
    }
    Ok(Launch {
        endpoint,
        token: arguments[4].clone(),
        host: arguments[6].clone(),
    })
}

/// Every desktop request names the exact Host and Session run, independently of shell windows.
pub fn binding_matches(binding: &Value, host: &str) -> bool {
    !host.is_empty()
        && binding["hostInstanceId"] == host
        && binding["runId"].as_str().is_some_and(|id| !id.is_empty())
        && binding["sessionId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
}

/// Unique within one helper process; the instance names the process lifetime.
pub fn resource_id(instance: &str) -> String {
    format!(
        "computer-{instance}-{}",
        RESOURCE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

pub fn instance_name() -> Result<String, String> {
    Ok(format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    ))
}

pub fn timestamp_millis() -> Result<String, String> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis()
        .to_string())
}

/// Proportional size whose longest edge does not exceed `limit`.
pub fn scaled_size(width: u32, height: u32, limit: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= limit || longest == 0 {
        return (width, height);
    }
    let scale = |value: u32| {
        ((value as u64 * limit as u64 + longest as u64 / 2) / longest as u64).max(1) as u32
    };
    (scale(width), scale(height))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Maps screenshot pixels of one observation back to desktop coordinates.
pub fn desktop_point(
    input: &Value,
    x: &str,
    y: &str,
    image: (f64, f64),
    bounds: Bounds,
) -> Result<(f64, f64), String> {
    let (px, py) = (
        input[x].as_f64().ok_or("Missing x coordinate")?,
        input[y].as_f64().ok_or("Missing y coordinate")?,
    );
    if !px.is_finite() || !py.is_finite() || px < 0.0 || py < 0.0 || px >= image.0 || py >= image.1
    {
        return Err("Coordinates must be inside the returned screenshot (image pixels).".into());
    }
    Ok((
        bounds.x + px * bounds.width / image.0,
        bounds.y + py * bounds.height / image.1,
    ))
}

/// Maps a desktop rectangle into the screenshot pixels of one observation.
pub fn image_rect(rect: Bounds, image: (f64, f64), bounds: Bounds) -> Bounds {
    let sx = image.0 / bounds.width;
    let sy = image.1 / bounds.height;
    Bounds {
        x: (rect.x - bounds.x) * sx,
        y: (rect.y - bounds.y) * sy,
        width: rect.width * sx,
        height: rect.height * sy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn observations_only_activate_for_explicit_foreground_requests() {
        for target in [
            serde_json::json!({"app":"test"}),
            serde_json::json!({"app":"test","windowId":42}),
        ] {
            assert!(!foreground_requested(&target));
            let mut request = target.clone();
            request["mode"] = serde_json::json!("background");
            assert!(!foreground_requested(&request));
            request["mode"] = serde_json::json!("foreground");
            assert!(foreground_requested(&request));
        }
    }

    fn arguments(endpoint: &str) -> Vec<String> {
        [
            "helper",
            "--connect",
            endpoint,
            "--token",
            "t",
            "--host",
            "h",
        ]
        .map(String::from)
        .to_vec()
    }

    #[test]
    fn launch_accepts_only_the_exact_loopback_host_contract() {
        let launch = launch_arguments(&arguments("127.0.0.1:4000")).unwrap();
        assert_eq!((launch.token.as_str(), launch.host.as_str()), ("t", "h"));
        assert!(launch_arguments(&arguments("10.0.0.2:4000")).is_err());
        assert!(launch_arguments(&arguments("not-an-endpoint")).is_err());
        assert!(launch_arguments(&arguments("127.0.0.1:4000")[..6]).is_err());
    }

    #[test]
    fn binding_requires_host_and_exact_run_without_a_gui_window() {
        let binding = json!({"hostInstanceId":"h","runId":"r","sessionId":"s"});
        assert!(binding_matches(&binding, "h"));
        assert!(!binding_matches(&binding, "other"));
        for field in ["runId", "sessionId"] {
            let mut partial = binding.clone();
            partial.as_object_mut().unwrap().remove(field);
            assert!(!binding_matches(&partial, "h"));
            partial[field] = json!("");
            assert!(!binding_matches(&partial, "h"));
        }
    }

    #[test]
    fn screenshots_scale_proportionally_and_coordinates_round_trip() {
        assert_eq!(scaled_size(3200, 1800, 1600), (1600, 900));
        assert_eq!(scaled_size(900, 2400, 1600), (600, 1600));
        assert_eq!(scaled_size(800, 600, 1600), (800, 600));
        let bounds = Bounds {
            x: -1920.0,
            y: 100.0,
            width: 3200.0,
            height: 1800.0,
        };
        let image = (1600.0, 900.0);
        let point = desktop_point(&json!({"x":800,"y":450}), "x", "y", image, bounds).unwrap();
        assert_eq!(point, (-320.0, 1000.0));
        let rect = image_rect(
            Bounds {
                x: -320.0,
                y: 1000.0,
                width: 200.0,
                height: 100.0,
            },
            image,
            bounds,
        );
        assert_eq!(
            rect,
            Bounds {
                x: 800.0,
                y: 450.0,
                width: 100.0,
                height: 50.0
            }
        );
        for outside in [
            json!({"x":1600,"y":1}),
            json!({"x":-1,"y":1}),
            json!({"x":1}),
        ] {
            assert!(desktop_point(&outside, "x", "y", image, bounds).is_err());
        }
    }

    #[test]
    fn resource_ids_are_unique_within_an_instance() {
        assert_ne!(resource_id("i"), resource_id("i"));
        assert!(resource_id("pid-1").starts_with("computer-pid-1-"));
    }
}
