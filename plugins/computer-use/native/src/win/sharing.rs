//! Windows implementation of the existing private current-target presentation
//! channel. Only admitted tool calls acquire captures; preview reads acquire none.
use super::{
    capture,
    desktop::{self, Window},
    indicator, wgc,
};
use crate::protocol;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

type Run = (String, String, String);
static GENERATION: AtomicU64 = AtomicU64::new(1);

fn run(binding: &Value) -> Run {
    (
        binding["hostInstanceId"]
            .as_str()
            .unwrap_or_default()
            .into(),
        binding["sessionId"].as_str().unwrap_or_default().into(),
        binding["runId"].as_str().unwrap_or_default().into(),
    )
}

struct Pointer {
    x: f64,
    y: f64,
    at: Instant,
}

struct Source {
    window: Window,
    generation: u64,
    capture: wgc::Capture,
    pointer: Mutex<Option<Pointer>>,
    encoded: Mutex<Option<Value>>,
}

#[derive(Default)]
pub struct Sharing {
    sources: Mutex<HashMap<Run, Arc<Source>>>,
}

impl Sharing {
    fn source(&self, binding: &Value) -> Result<Option<Arc<Source>>, String> {
        Ok(self
            .sources
            .lock()
            .map_err(|_| "Windows sharing state unavailable")?
            .get(&run(binding))
            .cloned())
    }

    pub fn ensure(&self, binding: &Value, window: &Window) -> Result<u64, String> {
        if let Some(source) = self.source(binding)? {
            if wgc::same_window(&source.window, window) && source.capture.latest().is_ok() {
                return Ok(source.generation);
            }
            self.release(binding)?;
        }
        let capture = wgc::Capture::start(window, 720)?;
        let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
        let source = Arc::new(Source {
            window: window.clone(),
            generation,
            capture,
            pointer: Mutex::new(None),
            encoded: Mutex::new(None),
        });
        self.sources
            .lock()
            .map_err(|_| "Windows sharing state unavailable")?
            .insert(run(binding), source);
        Ok(generation)
    }

    pub fn validate(
        &self,
        binding: &Value,
        window: &Window,
        generation: u64,
    ) -> Result<(), String> {
        let source = self
            .source(binding)?
            .ok_or("The captured target has been released; observe again")?;
        if source.generation != generation || !wgc::same_window(&source.window, window) {
            return Err("The captured target changed; observe again".into());
        }
        source.capture.latest()?;
        Ok(())
    }

    pub fn point(&self, binding: &Value, window: &Window, point: (f64, f64)) -> Result<(), String> {
        let source = self
            .source(binding)?
            .ok_or("The captured target has been released")?;
        if !wgc::same_window(&source.window, window) {
            return Err("The captured target changed".into());
        }
        *source
            .pointer
            .lock()
            .map_err(|_| "Windows pointer state unavailable")? = Some(Pointer {
            x: (point.0 - window.bounds.x) / window.bounds.width,
            y: (point.1 - window.bounds.y) / window.bounds.height,
            at: Instant::now(),
        });
        indicator::show(window, binding, Some(point))
    }

    pub fn release(&self, binding: &Value) -> Result<(), String> {
        let source = self
            .sources
            .lock()
            .map_err(|_| "Windows sharing state unavailable")?
            .remove(&run(binding));
        let stopped = source.map_or(Ok(()), |source| source.capture.stop());
        let indicated = indicator::finish_run(binding);
        stopped.and(indicated)
    }

    pub fn shutdown(&self) -> Result<(), String> {
        let sources = std::mem::take(
            &mut *self
                .sources
                .lock()
                .map_err(|_| "Windows sharing state unavailable")?,
        );
        let mut errors = Vec::new();
        for ((host, session, run), source) in sources {
            if let Err(error) = source.capture.stop() {
                errors.push(error);
            }
            if let Err(error) = indicator::finish_run(
                &json!({"hostInstanceId":host,"sessionId":session,"runId":run}),
            ) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    pub fn activate(&self, binding: &Value, input: &Value) -> Result<Value, String> {
        let source = self.source(binding)?.ok_or("No active captured target")?;
        if input["windowId"] != source.window.id || input["generation"] != source.generation {
            return Err("The preview target changed".into());
        }
        source.capture.latest()?;
        let window = desktop::snapshot(source.window.id)?;
        if !wgc::same_window(&source.window, &window) {
            return Err("The preview window identity changed".into());
        }
        desktop::focus(&window)?;
        Ok(json!({"activated":true,"windowId":window.id,"generation":source.generation}))
    }

    pub fn preview(&self, binding: &Value, after: Option<u64>) -> Result<Value, String> {
        let Some(source) = self.source(binding)? else {
            return Ok(json!({"state":"inactive"}));
        };
        let mut value = json!({"state":"starting","target": {
            "windowId":source.window.id,"pid":source.window.pid,"app":source.window.app,
            "title":source.window.title,"generation":source.generation,
            "width":source.window.bounds.width,"height":source.window.bounds.height }});
        let observed = (|| -> Result<(), String> {
            let window = desktop::snapshot(source.window.id)?;
            if !wgc::same_window(&source.window, &window) {
                return Err("The preview window identity changed".into());
            }
            let Some(frame) = source.capture.latest()? else {
                return Ok(());
            };
            if (window.bounds.width, window.bounds.height)
                != (frame.window.bounds.width, frame.window.bounds.height)
            {
                return Ok(());
            }
            value["target"]["title"] = json!(window.title);
            value["target"]["width"] = json!(window.bounds.width);
            value["target"]["height"] = json!(window.bounds.height);
            value["state"] = json!("active");
            if after != Some(frame.sequence) {
                let mut encoded = source
                    .encoded
                    .lock()
                    .map_err(|_| "Windows preview cache unavailable")?;
                if encoded
                    .as_ref()
                    .and_then(|value| value["sequence"].as_u64())
                    != Some(frame.sequence)
                {
                    let png = capture::encode(&frame.image)?;
                    *encoded = Some(
                        json!({"sequence":frame.sequence,"capturedAt":frame.captured_at,
                        "width":frame.image.width,"height":frame.image.height,
                        "dataUrl":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(png))}),
                    );
                }
                value["frame"] = encoded.as_ref().expect("encoded frame").clone();
            }
            if let Some(pointer) = source
                .pointer
                .lock()
                .map_err(|_| "Windows pointer state unavailable")?
                .as_ref()
            {
                value["pointer"] = json!({"x":pointer.x,"y":pointer.y,"coordinateSpace":"target-normalized",
                    "pulse":pointer.at.elapsed() < Duration::from_millis(350)});
            }
            Ok(())
        })();
        if let Err(error) = observed {
            source.capture.stop()?;
            let sources = self
                .sources
                .lock()
                .map_err(|_| "Windows sharing state unavailable")?;
            if sources
                .get(&run(binding))
                .is_some_and(|current| Arc::ptr_eq(current, &source))
            {
                indicator::finish_run(binding)?;
            } else {
                return Ok(json!({"state":"inactive"}));
            }
            return Ok(json!({"state":"failed","reason":error,"target":value["target"]}));
        }
        // An in-flight read cannot republish a released or superseded source.
        if !self
            .source(binding)?
            .is_some_and(|current| Arc::ptr_eq(&current, &source))
        {
            return Ok(json!({"state":"inactive"}));
        }
        Ok(value)
    }
}

pub fn serve_previews(listener: TcpListener, sharing: Arc<Sharing>, host: String, token: String) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { break };
        let response = read_preview(&mut stream, &sharing, &host, &token);
        let response = match response {
            Ok(data) => json!({"ok":true,"data":data}),
            Err(message) => json!({"ok":false,"message":message}),
        };
        if let Err(error) = writeln!(stream, "{response}") {
            eprintln!("computer_preview_write_failed: {error}");
        }
    }
}

fn read_preview(
    stream: &mut TcpStream,
    sharing: &Sharing,
    host: &str,
    token: &str,
) -> Result<Value, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream.try_clone().map_err(|e| e.to_string())?)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let request: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    if request["token"] != token || !protocol::binding_matches(&request["binding"], host) {
        return Err("computer_preview_binding_mismatch".into());
    }
    if request["input"]["action"] != "computer:preview" {
        return Err("computer_preview_action_invalid".into());
    }
    sharing.preview(
        &request["binding"],
        request["input"]["afterSequence"].as_u64(),
    )
}
