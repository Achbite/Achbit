//! The desktop plugin owns the distinction between captured evidence and its inline view.
//! Run once after observation/dispatch, before the Host journals or replays the result.
use serde_json::{json, Value};
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;

const INLINE_BYTES: usize = 32 * 1024;
const TEXT_BYTES: usize = 256;
const SAMPLE_COUNT: usize = 8;

// Count encoded UTF-8 (including JSON escaping) without allocating a second multi-MB reply.
#[derive(Default)]
struct Size(usize);
impl Write for Size {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn size(v: &Value) -> usize {
    let mut n = Size::default();
    serde_json::to_writer(&mut n, v).expect("serializing a JSON value to a counter");
    n.0
}

// These are displayed labels/values, never handles or filesystem addresses. Keep both ends:
// e.g. the reason at the beginning of a diagnostic and its recovery advice at the end.
fn preview(v: &Value) -> Value {
    match v {
        Value::String(s) if s.len() > TEXT_BYTES => {
            let mut left = TEXT_BYTES * 3 / 4;
            let mut right = s.len() - (TEXT_BYTES - left - '…'.len_utf8());
            while !s.is_char_boundary(left) {
                left -= 1;
            }
            while !s.is_char_boundary(right) {
                right += 1;
            }
            Value::String(format!("{}…{}", &s[..left], &s[right..]))
        }
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), preview(v))).collect()),
        Value::Array(a) => Value::Array(a.iter().take(SAMPLE_COUNT).map(preview).collect()),
        other => other.clone(),
    }
}

// AX can report many custom actions, but only AXPress is dispatched by the Mac
// press path. Never hide that capability behind an arbitrary prefix of the list.
fn supports_press(action: &Value) -> bool {
    matches!(
        action.as_str(),
        Some("AXPress" | "invoke" | "toggle" | "select" | "expand" | "collapse")
    )
}

fn element_preview(node: &Value) -> Value {
    let mut item = preview(node);
    if let Some(actions) = node["actions"]
        .as_array()
        .filter(|a| a.len() > SAMPLE_COUNT)
    {
        let mut supported = Vec::new();
        for action in actions.iter().filter(|a| supports_press(a)) {
            if !supported.contains(action) {
                supported.push(action.clone());
            }
        }
        if !supported.is_empty() {
            item["actions"] = Value::Array(supported);
        }
    }
    item
}

fn priority(node: &Value, width: f64, height: f64) -> u8 {
    let b = &node["bounds"];
    let visible = node["offscreen"] != true
        && matches!(
            (b["x"].as_f64(), b["y"].as_f64(), b["width"].as_f64(), b["height"].as_f64()),
            (Some(x),Some(y),Some(w),Some(h)) if w > 0. && h > 0. && x < width && y < height && x+w > 0. && y+h > 0.
        );
    let actionable = node["enabled"] != false
        && (node["valueSettable"] == true
            || node["actions"]
                .as_array()
                .is_some_and(|a| a.iter().any(supports_press)));
    match (visible, actionable) {
        (true, true) => 1,
        (true, false) => 2,
        (false, true) => 3,
        _ => 4,
    }
}

fn archive(data: &Value, input: &Value, instance: &str) -> io::Result<std::path::PathBuf> {
    // captureDirectory is supplied by the owning Host, not by the observed application.
    let directory = input["captureDirectory"]
        .as_str()
        .ok_or_else(|| io::Error::other("no invocation archive directory"))?;
    let directory = Path::new(directory);
    // A dispatched action can fail to capture a new frame, so there may be no PNG yet.
    std::fs::create_dir_all(directory)?;
    let path = directory.join(format!(
        "{}-observation.json",
        crate::protocol::resource_id(instance)
    ));
    let file = File::create_new(&path)?;
    let written = (|| -> io::Result<()> {
        let mut writer = BufWriter::new(&file);
        serde_json::to_writer(&mut writer, data)?;
        writer.flush()?;
        file.sync_all()
    })();
    drop(file);
    if let Err(error) = written {
        // Only this create_new file is ours. Never advertise a partial archive as complete.
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(path)
}

/// Small results pass through unchanged. Oversized observations (including post-action
/// verification without a new screenshot) keep exact identity, native coverage and effects.
/// No re-observation, new input, or change to the native handle table occurs here.
pub(crate) fn for_host(mut data: Value, input: &Value, instance: &str) -> Value {
    if !data["observationId"].is_string() && data["dispatched"] != true {
        return data;
    }
    let raw_bytes = size(&data);
    if raw_bytes <= INLINE_BYTES {
        return data;
    }
    let full = archive(&data, input, instance);
    let width = data["width"].as_f64().unwrap_or_default();
    let height = data["height"].as_f64().unwrap_or_default();
    let mut view = json!({"truncated":true});
    for key in ["errors", "candidateErrors"] {
        if let Some(errors) = data["accessibility"][key].as_array() {
            view["diagnosticCounts"][key] = json!(errors.len());
        }
    }
    let fields = data
        .as_object_mut()
        .expect("native observation is an object");
    let elements = fields.remove("elements");
    for (key, value) in fields.iter_mut() {
        // These addresses must remain usable verbatim; do not clip a path/ID to fit text.
        if !matches!(
            key.as_str(),
            "app" | "observationId" | "contentRef" | "capturedAt"
        ) {
            *value = preview(value);
        }
    }
    match full {
        Ok(path) => view["fullOutput"] = json!({"path":path,"bytes":raw_bytes}),
        Err(error) => {
            view["archiveError"] = json!({"message":error.to_string()});
            // Retain an existing verification/observation error and dispatched=true. The
            // existing Host failure contract reports incomplete evidence without retrying input.
            fields.entry("observationError").or_insert_with(|| json!({"message":"Could not archive the complete desktop observation. Only the inline sample is available; do not repeat a dispatched action to recover it."}));
        }
    }
    fields.insert("observationView".into(), view);
    if let Some(Value::Array(nodes)) = elements {
        let count = nodes.len();
        data["observationView"]["totalElements"] = json!(count);
        // The desktop activity UI and execution reviewer also consume accessibility on its
        // own. Native traversal completeness does not mean they have every node or error.
        if data["accessibility"].is_object() {
            data["accessibility"]["inlineTruncated"] = json!(true);
            for key in ["errors", "candidateErrors"] {
                if let Some(errors) = data["accessibility"][key].as_array_mut() {
                    let mut remaining = INLINE_BYTES / 8;
                    errors.retain(|e| {
                        let bytes = size(e) + 1;
                        if bytes > remaining {
                            false
                        } else {
                            remaining -= bytes;
                            true
                        }
                    });
                }
            }
        }
        data["elements"] = json!([]);
        // Reserve the already serialized envelope, then charge each preview and separator.
        let mut remaining = INLINE_BYTES.saturating_sub(size(&data));
        let mut indices: Vec<_> = (0..count).collect();
        indices.sort_by_cached_key(|&i| {
            if i == 0 {
                0
            } else {
                priority(&nodes[i], width, height)
            }
        });
        let mut kept = Vec::new();
        for index in indices {
            if remaining < 16 {
                break;
            }
            let item = element_preview(&nodes[index]);
            let bytes = size(&item) + usize::from(!kept.is_empty());
            if bytes <= remaining {
                remaining -= bytes;
                kept.push((index, item));
            }
        }
        // Screen readers, reviewers and input consumers use native order and original IDs.
        kept.sort_unstable_by_key(|(index, _)| *index);
        data["elements"] = Value::Array(kept.into_iter().map(|(_, v)| v).collect());
    }
    data
}

#[cfg(test)]
mod tests;
