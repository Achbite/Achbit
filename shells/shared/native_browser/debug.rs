//! Debug-only product control. Commands are fixed UI operations; callers cannot
//! submit JavaScript or spawn host processes. The existing authenticated native
//! browser connection owns transport, lifetime and the product binding.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
static NEXT: AtomicU64 = AtomicU64::new(1);

pub fn initialization_script() -> &'static str {
    include_str!("debug_dom.js")
}

fn target(input: &Value) -> Result<(String, Vec<u64>), String> {
    let target = input["target"].as_str().unwrap_or("main");
    let (view, path) = target.split_once("::frame:").unwrap_or((target, ""));
    let frame = if path.is_empty() {
        vec![]
    } else {
        path.split('.')
            .map(|part| {
                part.parse::<u64>()
                    .map_err(|_| "debug_invalid_frame_target".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok((view.to_string(), frame))
}
fn directory(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.state::<super::NativeBrowser>()
        .directories
        .data_dir
        .join("debug")
        .join("ui")
}
fn stamp() -> Result<u128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis())
}

fn operation_id(app: &tauri::AppHandle, kind: &str) -> String {
    format!(
        "gui-{kind}-{}-{}",
        app.state::<super::NativeBrowser>().binding.host_instance_id,
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn store_receipt(app: &tauri::AppHandle, id: &str, receipt: &Value) -> Result<(), String> {
    let directory = directory(app);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let pending = directory.join(format!("{id}.pending"));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|error| error.to_string())?;
        file.write_all(&serde_json::to_vec(receipt).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        fs::rename(&pending, directory.join(format!("{id}.json")))
            .map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(pending);
    }
    result
}

// Query derives samples from the GUI-owned receipts. A component measurement
// collected with an operation is not evidence that the operation caused it.
fn query_metrics(records: Vec<Value>, input: &Value) -> Result<Value, String> {
    let bound = |field: &str| -> Result<Option<f64>, String> {
        match input.get(field) {
            None => Ok(None),
            Some(value) => value
                .as_f64()
                .or_else(|| value.as_str()?.parse().ok())
                .filter(|number| number.is_finite() && *number >= 0.0)
                .map(Some)
                .ok_or_else(|| format!("debug_invalid_metric_{field}")),
        }
    };
    let from = bound("fromMs")?;
    let to = bound("toMs")?;
    if from.zip(to).is_some_and(|(from, to)| from > to) {
        return Err("debug_invalid_metric_time_range".into());
    }
    let groups: Vec<&str> = input["groupBy"]
        .as_str()
        .unwrap_or("event,status")
        .split(',')
        .filter(|field| !field.is_empty())
        .collect();
    if groups
        .iter()
        .any(|field| !matches!(*field, "component" | "event" | "status" | "surface"))
    {
        return Err("debug_invalid_metric_group_by".into());
    }
    let matches = |sample: &Value| {
        [
            ("operationId", "operationId"),
            ("component", "componentId"),
            ("event", "event"),
            ("status", "status"),
            ("surface", "surface"),
            ("phase", "phase"),
        ]
        .iter()
        .all(|(filter, field)| {
            input
                .get(*filter)
                .is_none_or(|value| *value == sample[*field])
        }) && from.is_none_or(|bound| {
            sample["occurredAtMs"]
                .as_f64()
                .is_some_and(|time| time >= bound)
        }) && to.is_none_or(|bound| {
            sample["occurredAtMs"]
                .as_f64()
                .is_some_and(|time| time <= bound)
        })
    };
    let mut sources = Vec::new();
    let mut samples = Vec::new();
    let mut collection_failures = Vec::new();
    let mut dropped = 0;
    for record in records {
        if record["coverage"] == "unavailable" {
            collection_failures.push(record);
            continue;
        }
        dropped += record["components"]["dropped"].as_u64().unwrap_or(0);
        let first = samples.len();
        if input["kind"] != "component" && record["kind"] == "ui" {
            for (phase, duration, clock, pointer) in [
                (
                    "response-observed",
                    &record["responseDurationMs"],
                    "gui.monotonic",
                    "/responseDurationMs",
                ),
                (
                    "observation-total",
                    &record["totalDurationMs"],
                    "gui.monotonic",
                    "/totalDurationMs",
                ),
                (
                    "screenshot",
                    &record["screenshot"]["durationMs"],
                    "gui.monotonic",
                    "/screenshot/durationMs",
                ),
                (
                    "dom-handler",
                    &record["result"]["timing"]["handlerDurationMs"],
                    "webview.performance",
                    "/result/timing/handlerDurationMs",
                ),
                (
                    "dom-observed",
                    &record["result"]["timing"]["observedDurationMs"],
                    "webview.performance",
                    "/result/timing/observedDurationMs",
                ),
            ] {
                // Native actions do not contain DOM stages; they are inapplicable.
                if phase.starts_with("dom-") && record["result"]["timing"].is_null() {
                    continue;
                }
                let sample = json!({"owner":"gui","operationId":record["operationId"],"recordRef":record["recordRef"],"sourcePointer":pointer,"surface":record["target"],"event":record["name"],"phase":phase,"status":record["status"],"occurredAtMs":record["acceptedAtMs"],"clockDomain":clock,"durationMs":duration,"association":"operation"});
                if matches(&sample) {
                    samples.push(sample);
                }
            }
        }
        if input["kind"] != "ui" {
            for (index, span) in record["components"]["records"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                let sample = json!({"owner":"gui","operationId":record["operationId"],"recordRef":record["recordRef"],"sourcePointer":format!("/components/records/{index}"),"surface":record["target"],"componentId":span["componentId"],"event":span["event"],"phase":if matches!(span["event"].as_str(),Some("plugin.mount"|"plugin.update")){"plugin-renderer"}else{"component-handler"},"status":span["outcome"],"occurredAtMs":span["occurredAtMs"],"clockDomain":span["clockDomain"],"durationMs":span["durationMs"],"association":"collection-receipt"});
                if matches(&sample) {
                    samples.push(sample);
                }
            }
        }
        if samples.len() > first {
            sources.push(record);
        }
    }
    let mut grouped: BTreeMap<String, (Value, Vec<&Value>)> = BTreeMap::new();
    for sample in &samples {
        // Always split phase and clock domain, even if callers omit them.
        let mut key = json!({"phase":sample["phase"],"clockDomain":sample["clockDomain"]});
        for group in &groups {
            key[*group] = sample[if *group == "component" {
                "componentId"
            } else {
                *group
            }]
            .clone();
        }
        grouped
            .entry(key.to_string())
            .or_insert_with(|| (key, Vec::new()))
            .1
            .push(sample);
    }
    let summaries: Vec<Value> = grouped.into_values().map(|(group, rows)| {
        let mut values: Vec<f64> = rows.iter().filter_map(|row| row["durationMs"].as_f64())
            .filter(|duration| duration.is_finite() && *duration >= 0.0).collect();
        values.sort_by(f64::total_cmp);
        let mut statuses: BTreeMap<String, usize> = BTreeMap::new();
        for row in &rows { *statuses.entry(row["status"].as_str().unwrap_or("unrecorded").into()).or_default() += 1; }
        let total = (!values.is_empty()).then(|| values.iter().sum::<f64>());
        let percentile = |fraction: f64| (!values.is_empty()).then(|| values[((values.len() as f64 * fraction).ceil() as usize).saturating_sub(1)]);
        json!({"group":group,"requestSamples":rows.len(),"validDurationSamples":values.len(),"missingDurationSamples":rows.len()-values.len(),"statuses":statuses,"totalDurationMs":total,"minDurationMs":values.first(),"maxDurationMs":values.last(),"meanDurationMs":total.map(|sum|sum/values.len() as f64),"p50DurationMs":percentile(0.5),"p95DurationMs":percentile(0.95),"percentileMethod":"nearest-rank","sampleRefs":rows.iter().map(|row|json!({"recordRef":row["recordRef"],"sourcePointer":row["sourcePointer"]})).collect::<Vec<_>>()})
    }).collect();
    Ok(
        json!({"records":sources,"samples":samples,"summaries":summaries,"filters":input,"coverage":{"scope":"selected samples; records retain complete source receipts","collectionFailures":collection_failures,"droppedComponentMeasurements":dropped,"inFlight":"not-collected","durationMeaning":"measured stages; sums are not task wall time"}}),
    )
}

#[cfg(target_os = "macos")]
async fn dispatch(view: tauri::Webview, request: Value) -> Result<Value, String> {
    use objc2::{msg_send, runtime::AnyObject, MainThreadOnly};
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};
    let script = format!("try {{ if (!window.__DEEPCODE_DEBUG_DOM__) throw Error('debug_bridge_not_loaded'); return JSON.stringify({{ok:true,value:await window.__DEEPCODE_DEBUG_DOM__.dispatch({request})}}); }} catch(error) {{ return JSON.stringify({{ok:false,error:String(error)}}); }}");
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    view.with_webview(move |platform| unsafe {
        let webview = &*(platform.inner() as *const WKWebView);
        let completion = block2::RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
            let result = if let Some(error) = error.as_ref() {
                Err(error.localizedDescription().to_string())
            } else if value.is_null() {
                Err("debug_script_returned_no_result".to_string())
            } else {
                let text: *mut NSString = msg_send![value, description];
                serde_json::from_str::<Value>(&(*text).to_string())
                    .map_err(|error| error.to_string())
                    .and_then(|response| {
                        if response["ok"] == true {
                            Ok(response["value"].clone())
                        } else {
                            Err(response["error"]
                                .as_str()
                                .unwrap_or("debug_script_response_invalid")
                                .to_owned())
                        }
                    })
            };
            let _ = tx.send(result);
        });
        webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(&script),
            None,
            None,
            &WKContentWorld::pageWorld(webview.mtm()),
            Some(&completion),
        );
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(30))
            .map_err(|error| format!("debug_ui_response_timeout: {error}"))?
    })
    .await
    .map_err(|error| error.to_string())?
}
#[cfg(not(target_os = "macos"))]
async fn dispatch(_view: tauri::Webview, _request: Value) -> Result<Value, String> {
    Err("debug_platform_not_supported".into())
}

async fn dialogs(app: &tauri::AppHandle, name: &str, args: Value) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let name = name.to_string();
        let local_name = if matches!(name.as_str(), "menus" | "menu" | "cancel") {
            name.clone()
        } else {
            "inspect".into()
        };
        let local_args = args.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let _ = tx.send(crate::native_path_dialog::debug_command(
                &local_name,
                &local_args,
            ));
        })
        .map_err(|error| error.to_string())?;
        return tauri::async_runtime::spawn_blocking(move || {
            let state = rx
                .recv_timeout(Duration::from_secs(10))
                .map_err(|error| error.to_string())??;
            if matches!(name.as_str(), "menus" | "menu" | "cancel") || state["status"] == "closed" {
                return if state["status"] == "closed" && name != "inspect" {
                    Err("debug_native_dialog_not_open".into())
                } else {
                    Ok(state)
                };
            }
            crate::native_path_dialog::debug_accessibility_command(&name, &args, state)
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, name, args);
        Err("debug_platform_not_supported".into())
    }
}

async fn snapshot(app: &tauri::AppHandle, view: tauri::Webview, id: &str) -> Result<Value, String> {
    let started = Instant::now();
    let directory = directory(app).join("captures");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!("{id}.png"));
    #[cfg(target_os = "macos")]
    {
        let native_path = path.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            crate::native_path_dialog::debug_capture(native_path, tx);
        })
        .map_err(|error| error.to_string())?;
        let native = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(10))
                .map_err(|error| error.to_string())?
        })
        .await
        .map_err(|error| error.to_string())??;
        if let Some(mut native) = native {
            native["durationMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
            return Ok(native);
        }
    }
    let captured = super::capture(view).await?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(&captured.bytes)
        .map_err(|error| error.to_string())?;
    Ok(
        json!({"contentRef":path,"contentType":"image/png","width":captured.width,"height":captured.height,"range":"webview-viewport","durationMs":started.elapsed().as_secs_f64()*1000.0}),
    )
}

pub async fn execute(app: tauri::AppHandle, input: Value) -> Result<Value, String> {
    let action = super::string(&input, "action")?;
    if action == "debug:shutdown" {
        if input["expectedPid"].as_u64() != Some(u64::from(std::process::id())) {
            return Err("debug_gui_pid_mismatch".into());
        }
        return Ok(
            json!({"status":"accepted","pid":std::process::id(),"hostInstanceId":app.state::<super::NativeBrowser>().binding.host_instance_id}),
        );
    }
    if action == "debug:surfaces" {
        let mut surfaces = Vec::new();
        for (id, view) in app.webviews() {
            // SSH auth and external permission windows are never operator automation targets.
            if id == "ssh-auth" {
                surfaces.push(json!({"id":id,"kind":"external-auth","status":"manual-required"}));
                continue;
            }
            let state = dispatch(view, json!({"name":"surfaces"})).await;
            match state {
                Ok(rows) => {
                    for row in rows.as_array().ok_or("debug_surface_response_invalid")? {
                        let path = row["framePath"]
                            .as_array()
                            .ok_or("debug_frame_path_missing")?;
                        let suffix = path
                            .iter()
                            .map(Value::to_string)
                            .collect::<Vec<_>>()
                            .join(".");
                        let surface_id = if suffix.is_empty() {
                            id.clone()
                        } else {
                            format!("{id}::frame:{suffix}")
                        };
                        surfaces.push(json!({"id":surface_id,"webviewId":id,"framePath":path,"kind":if id=="main"&&path.is_empty(){"desktop-gui"}else{"embedded-page"},"state":row["state"],"actions":["click","type","select","key","scroll","focus","wait","plugin.action"]}));
                    }
                }
                Err(error) => surfaces.push(json!({"id":id,"status":"unavailable","error":error})),
            }
        }
        let native = dialogs(&app, "inspect", json!({})).await?;
        let menus = dialogs(&app, "menus", json!({})).await?;
        Ok(json!({"surfaces":surfaces,"nativeDialogs":native,"nativeMenus":menus}))
    } else if action == "debug:metrics" {
        let mut records = Vec::new();
        let path = directory(&app);
        for (id, view) in app.webviews() {
            if id == "ssh-auth" {
                continue;
            }
            match dispatch(view, json!({"name":"metrics"})).await {
                Ok(measurements) if measurements["records"].as_array().is_some_and(|rows|!rows.is_empty()) || measurements["dropped"].as_u64().is_some_and(|count|count>0) => {
                    let record_id = operation_id(&app, "measurement");
                    let record = json!({"operationId":record_id,"kind":"component-measurements","target":id,"acceptedAtMs":stamp()?,"components":measurements});
                    store_receipt(&app, &record_id, &record)?;
                }
                Ok(_) => {},
                Err(error) => records.push(json!({"kind":"component-measurements","target":id,"coverage":"unavailable","error":error})),
            }
        }
        if path.exists() {
            for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
                {
                    let mut record: Value = serde_json::from_slice(
                        &fs::read(entry.path()).map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| error.to_string())?;
                    record["recordRef"] = json!(entry.path());
                    if input
                        .get("operationId")
                        .is_none_or(|id| record["operationId"] == *id)
                    {
                        records.push(record);
                    }
                }
            }
        }
        records.sort_by(|a, b| a["acceptedAtMs"].as_u64().cmp(&b["acceptedAtMs"].as_u64()));
        query_metrics(records, &input)
    } else if action == "debug:inspect" || action == "debug:components" {
        let (id, frame) = target(&input)?;
        if id == "native-dialog" {
            return dialogs(&app, "inspect", input["args"].clone()).await;
        }
        let view = app.get_webview(&id).ok_or("debug_surface_not_found")?;
        dispatch(view, json!({"name":if action=="debug:components"{"components"}else{"inspect"},"framePath":frame})).await
    } else if action == "debug:action" {
        let started = Instant::now();
        let accepted = stamp()?;
        let operation_id = operation_id(&app, "op");
        let (id, frame) = target(&input)?;
        let name = super::string(&input, "name")?;
        let args = input.get("args").cloned().unwrap_or_else(|| json!({}));
        let outcome = if name == "menu.select" {
            dialogs(&app, "menu", args).await
        } else if name.starts_with("dialog.") {
            dialogs(&app, name.trim_start_matches("dialog."), args).await
        } else if name.starts_with("window.") {
            let window = app.get_window(&id).ok_or("debug_window_not_found")?;
            match name {
                "window.focus" => window.set_focus(),
                "window.minimize" => window.minimize(),
                "window.show" => window.show(),
                "window.hide" => window.hide(),
                "window.maximize" => window.maximize(),
                "window.unmaximize" => window.unmaximize(),
                "window.close" => window.close(),
                _ => return Err("debug_window_action_not_supported".into()),
            }
            .map_err(|error| error.to_string())
            .map(|()| json!({"dispatched":true}))
        } else {
            let view = app.get_webview(&id).ok_or("debug_surface_not_found")?;
            dispatch(view, json!({"name":name,"args":args,"framePath":frame})).await
        };
        let response_ms = started.elapsed().as_secs_f64() * 1000.0;
        let capture = if let Some(view) =
            app.get_webview(if id == "native-dialog" { "main" } else { &id })
        {
            match snapshot(&app, view, &operation_id).await {
                Ok(value) => value,
                Err(error) => {
                    json!({"status":if error.starts_with("manual-required:"){ "manual-required" } else { "unavailable" },"error":error})
                }
            }
        } else {
            json!({"status":"unavailable","reason":"surface-closed"})
        };
        let components = if let Some(view) = app.get_webview(&id) {
            dispatch(view, json!({"name":"metrics"}))
                .await
                .unwrap_or_else(|error| json!({"coverage":"unavailable","error":error}))
        } else {
            json!({"coverage":"not-applicable"})
        };
        let native = dialogs(&app, "inspect", json!({}))
            .await
            .unwrap_or_else(|error| json!({"status":"unavailable","error":error}));
        let mut receipt = json!({"operationId":operation_id,"origin":"debugOperation","kind":"ui","target":input["target"].as_str().unwrap_or("main"),"name":name,"acceptedAtMs":accepted,"responseDurationMs":response_ms,"totalDurationMs":started.elapsed().as_secs_f64()*1000.0,"clockDomain":"gui.monotonic","screenshot":capture,"nativeDialogs":native,"components":components});
        match outcome {
            Ok(value) => {
                receipt["status"] = json!("observed");
                receipt["result"] = value;
            }
            Err(error) => {
                receipt["status"] = json!("failed");
                receipt["error"] = json!(error);
            }
        }
        store_receipt(&app, &operation_id, &receipt)?;
        Ok(receipt)
    } else {
        Err("debug_gui_operation_not_supported".into())
    }
}
