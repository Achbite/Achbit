//! Windows desktop executor. The process is per-monitor DPI aware, so window
//! bounds, UI Automation rectangles, screenshots and input all use physical
//! desktop pixels. The Kernel admits every call; this process owns no policy.
mod capture;
mod desktop;
mod indicator;
mod input;
mod uia;

use crate::protocol::{self, Bounds};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, Instant};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::IUIAutomationElement;
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

/// E_ACCESSDENIED: the awareness was already fixed (for example by a manifest).
const AWARENESS_ALREADY_SET: i32 = 0x8007_0005_u32 as i32;

pub fn run() -> Result<(), String> {
    let arguments: Vec<String> = std::env::args().collect();
    let launch = protocol::launch_arguments(&arguments)?;
    unsafe {
        // Must precede every window query; otherwise Windows virtualizes coordinates per DPI.
        if let Err(error) =
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
        {
            if error.code().0 != AWARENESS_ALREADY_SET {
                return Err(format!("Per-monitor DPI awareness unavailable: {error}"));
            }
        }
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|error| format!("COM initialization failed: {error}"))?;
    }
    let mut stream = TcpStream::connect_timeout(&launch.endpoint, Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    writeln!(
        stream,
        "{}",
        json!({"token":launch.token,"pid":std::process::id()})
    )
    .map_err(|error| error.to_string())?;
    let mut executor = Executor::new(protocol::instance_name()?)?;
    // The owning Host's connection is this process lifetime: EOF ends the process.
    serve(&mut executor, &launch.host, &mut stream)
}

fn serve(executor: &mut Executor, host: &str, stream: &mut TcpStream) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Ok(());
        }
        let request: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let binding = &request["binding"];
        let result = if protocol::binding_matches(binding, host) {
            executor.execute(binding, &request["input"])
        } else {
            Err("computer_host_binding_mismatch".into())
        };
        indicator::finish_call();
        let response = match result {
            Ok(data) => json!({"ok":true,"data":data}),
            Err(message) => json!({"ok":false,"message":message,"diagnostics":{
                "phase":request["input"]["action"],"native":status()}}),
        };
        writeln!(stream, "{response}").map_err(|e| e.to_string())?;
    }
}

pub(crate) fn status() -> Value {
    json!({
        "platform":"windows",
        "executor":{"pid":std::process::id(),
            "executable":std::env::current_exe().map(|path| path.display().to_string()).unwrap_or_default(),
            "integrityLevel":desktop::integrity_name(desktop::own_integrity())},
        // Windows has no per-app Accessibility or Screen Recording grant. Windows of a
        // higher integrity level (for example elevated apps) reject UI Automation and input.
        "permissions":{"accessibility":true,"screenCapture":true,"systemGrantRequired":false},
        "capabilities":{"capture":true,"accessibility":true,"input":true,"exactWindowIdentity":true,
            "backgroundObservation":true,"indicator":true,"backgroundForegroundRestore":true},
        "coordinateSpace":"physical desktop pixels (per-monitor DPI aware)"
    })
}

struct Observation {
    id: String,
    app: String,
    window: desktop::Window,
    at: Instant,
    foreground: bool,
    binding: Value,
    image: (f64, f64),
    elements: Vec<IUIAutomationElement>,
}

struct Executor {
    instance: String,
    automation: uia::Automation,
    // One physical desktop observation at a time, across all bound sessions.
    observation: Option<Observation>,
}

impl Executor {
    fn new(instance: String) -> Result<Self, String> {
        Ok(Self {
            instance,
            automation: uia::Automation::new()?,
            observation: None,
        })
    }

    fn execute(&mut self, binding: &Value, input: &Value) -> Result<Value, String> {
        let action = input["action"]
            .as_str()
            .ok_or("Missing action")?
            .trim_start_matches("computer:");
        match action {
            // Kernel-owned run release; absent from public computer tools.
            "releaseRun" => {
                if self
                    .observation
                    .as_ref()
                    .is_some_and(|saved| saved.binding == *binding)
                {
                    self.observation = None;
                }
                indicator::finish_run(binding)?;
                return Ok(json!({"released":true}));
            }
            "status" => return Ok(status()),
            "listApps" => return desktop::applications(),
            "listWindows" => return desktop::windows_json(),
            "capture" => return self.capture(binding, input),
            _ => {}
        }
        let app = desktop::normalize_app(input["app"].as_str().ok_or("Missing app")?)?;
        if action == "observe" {
            self.observation = None;
            let (observation, output) = self.observe(input, &app, binding)?;
            self.observation = Some(observation);
            return Ok(output);
        }
        let saved = self
            .observation
            .take()
            .ok_or("Observe the application before acting")?;
        if input["observationId"] != saved.id.as_str()
            || saved.app != app
            || saved.binding != *binding
            || saved.at.elapsed() > Duration::from_secs(protocol::OBSERVATION_LIFETIME_SECONDS)
        {
            return Err("Observation is stale; observe again before acting".into());
        }
        // HWNDs can be reused: the process, class and geometry must all be unchanged.
        if desktop::snapshot(saved.window.id)? != saved.window {
            return Err("Target window changed; observe again before acting".into());
        }
        let semantic = matches!(action, "press" | "setValue");
        // A background observation promises not to move the user's foreground window.
        let guard = (!saved.foreground).then(desktop::ForegroundGuard::capture);
        if semantic {
            indicator::show(
                &saved.window,
                binding,
                uia::element_center(&saved.elements, input),
            )?;
            let performed = uia::perform(&saved.elements, input, action);
            if let Err(error) = performed {
                return Err(
                    match guard
                        .as_ref()
                        .and_then(|guard| guard.restore(&saved.window))
                    {
                        Some(change) => format!("{error} Foreground change: {change}"),
                        None => error,
                    },
                );
            }
        } else {
            if !saved.foreground {
                return Err("This input requires an explicit foreground observation; background mode supports press and setValue only".into());
            }
            desktop::focus(&saved.window)?;
            if desktop::snapshot(saved.window.id)? != saved.window {
                return Err("Target window changed while restoring focus; observe again".into());
            }
            indicator::show(&saved.window, binding, None)?;
            input::dispatch(input, action, saved.image, saved.window.bounds)?;
        }
        // A short bounded delay lets the application process dispatched input. A
        // screenshot remains an observation, not a claim that backend work settled.
        std::thread::sleep(Duration::from_millis(200));
        let mut foreground = guard
            .as_ref()
            .and_then(|guard| guard.restore(&saved.window));
        let mut next = input.clone();
        next["windowId"] = json!(saved.window.id);
        next["mode"] = json!(if saved.foreground {
            "foreground"
        } else {
            "background"
        });
        let observed = self.observe(&next, &app, binding);
        // Some apps activate themselves asynchronously after the action.
        if foreground.is_none() {
            foreground = guard
                .as_ref()
                .and_then(|guard| guard.restore(&saved.window));
        }
        match observed {
            Ok((fresh, mut output)) => {
                self.observation = Some(fresh);
                output["action"] = json!(action);
                output["dispatched"] = json!(true);
                if let Some(change) = foreground {
                    output["foregroundChange"] = change;
                }
                Ok(output)
            }
            Err(message) => {
                let mut output = json!({"app":app,"action":action,"dispatched":true,
                    "observationError":{"message":message}});
                if let Some(change) = foreground {
                    output["foregroundChange"] = change;
                }
                Ok(output)
            }
        }
    }

    fn capture(&self, binding: &Value, input: &Value) -> Result<Value, String> {
        let directory = capture_directory(input)?;
        let (image, target) = if let Some(id) = input["windowId"].as_u64() {
            let window = desktop::snapshot(u32::try_from(id).map_err(|_| "Invalid windowId")?)?;
            indicator::show(&window, binding, None)?;
            (capture::window(&window)?, json!({"windowId":window.id}))
        } else if input["display"] == "primary" {
            (capture::primary_display()?, json!({"display":"primary"}))
        } else {
            return Err("capture requires exactly one display=primary or a valid windowId".into());
        };
        let id = protocol::resource_id(&self.instance);
        let (path, width, height) = capture::save(&image, directory, &id)?;
        Ok(
            json!({"captureId":id,"contentRef":path,"contentType":"image/png","width":width,
            "height":height,"target":target,"capturedAt":protocol::timestamp_millis()?}),
        )
    }

    fn observe(
        &self,
        input: &Value,
        app: &str,
        binding: &Value,
    ) -> Result<(Observation, Value), String> {
        let directory = capture_directory(input)?;
        let window_id = match input.get("windowId") {
            Some(value) => Some(
                value
                    .as_u64()
                    .and_then(|id| u32::try_from(id).ok())
                    .ok_or("Invalid windowId")?,
            ),
            None => None,
        };
        let foreground = input["mode"].as_str().unwrap_or(if window_id.is_some() {
            "background"
        } else {
            "foreground"
        }) == "foreground";
        let window = match window_id {
            Some(id) => desktop::snapshot(id)?,
            None => desktop::app_window(app)?,
        };
        if !desktop::same_app(&window.app, app) {
            return Err(format!(
                "Window {} belongs to {}, not the requested app",
                window.id, window.app
            ));
        }
        desktop::ensure_controllable(&window)?;
        if foreground {
            desktop::focus(&window)?;
        }
        indicator::show(&window, binding, None)?;
        let tree = self.automation.tree(&window)?;
        let image = capture::window(&window)?;
        if desktop::snapshot(window.id)? != window {
            return Err("Target window changed during observation; observe again".into());
        }
        let id = protocol::resource_id(&self.instance);
        let (path, width, height) = capture::save(&image, directory, &id)?;
        let image_size = (width as f64, height as f64);
        let elements: Vec<Value> = tree
            .items
            .into_iter()
            .map(|mut item| {
                if let Some(rect) = item.bounds {
                    let mapped = protocol::image_rect(rect, image_size, window.bounds);
                    item.value["bounds"] = rect_json(mapped);
                }
                item.value
            })
            .collect();
        let mode = if foreground {
            "foreground"
        } else {
            "background"
        };
        let output = json!({"observationId":id,"app":app,
            "window":{"windowId":window.id,"title":window.title,"className":window.class,"bounds":rect_json(window.bounds)},
            "mode":mode,"elements":elements,"accessibility":tree.accessibility,
            "contentRef":path,"contentType":"image/png","width":width,"height":height,
            "capturedAt":protocol::timestamp_millis()?,"coordinateSpace":"window screenshot pixels"});
        Ok((
            Observation {
                id,
                app: app.into(),
                window,
                at: Instant::now(),
                foreground,
                binding: binding.clone(),
                image: image_size,
                elements: tree.handles,
            },
            output,
        ))
    }
}

fn capture_directory(input: &Value) -> Result<&Path, String> {
    input["captureDirectory"]
        .as_str()
        .map(Path::new)
        .ok_or_else(|| "Missing archive directory".into())
}

pub(crate) fn rect_json(bounds: Bounds) -> Value {
    json!({"x":bounds.x,"y":bounds.y,"width":bounds.width,"height":bounds.height})
}
