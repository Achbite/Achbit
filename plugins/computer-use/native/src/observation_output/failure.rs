use super::{archive_view, preview, size, INLINE_BYTES, SAMPLE_COUNT};
use serde_json::{json, Value};

/// The Kernel decodes `message` and `diagnostics` separately. Put the detail reference
/// inside diagnostics so it survives both decoding and the normal failed-tool projection.
/// Archive the original *failure*, not a successful observation or a new screenshot.
pub(crate) fn failure_for_host(mut reply: Value, input: &Value, instance: &str) -> Value {
    let bytes = size(&reply);
    if bytes <= INLINE_BYTES {
        return reply;
    }
    let mut view = archive_view(&reply, input, instance, bytes);
    let mut lists = Vec::new();
    if let Some(target) = reply["diagnostics"]["target"].as_object_mut() {
        for key in ["errors", "candidateErrors"] {
            if let Some(rows) = target.get_mut(key).and_then(Value::as_array_mut) {
                let mut rows = std::mem::take(rows);
                view["diagnosticCounts"][key] = json!(rows.len());
                rows.truncate(SAMPLE_COUNT);
                lists.push((key, rows));
            }
        }
    }
    reply["diagnostics"]["observationView"] = view;
    // Usually removing the two lists is enough; leave other fields (including native
    // executable paths and target identity) verbatim. A long scalar can also dominate.
    if size(&reply) > INLINE_BYTES {
        let d = &reply["diagnostics"];
        let mut core = json!({"observationView":d["observationView"]});
        for (path, keys) in [
            ("", &["phase", "recovery"][..]),
            (
                "/target",
                &["stage", "nativeCode", "targetPid", "windowId"][..],
            ),
            (
                "/screenCaptureKit",
                &["stage", "nativeDomain", "nativeCode", "message"][..],
            ),
            // Host releases a failed observe only on explicit unbound + inactive facts.
            ("/native", &["hasBoundObservation"][..]),
            ("/native/sharing", &["state", "generation", "windowId"][..]),
            (
                "/native/permissions",
                &["accessibility", "screenCapture"][..],
            ),
            ("/native/executor", &["pid"][..]),
        ] {
            if let Some(original) = d.pointer(path) {
                let mut dest = &mut core;
                for part in path.split('/').skip(1) {
                    dest = &mut dest[part];
                }
                for &k in keys {
                    if let Some(v) = original.get(k).filter(|v| !v.is_object() && !v.is_array()) {
                        dest[k] = preview(v);
                    }
                }
            }
        }
        reply["message"] = preview(&reply["message"]);
        reply["diagnostics"] = core;
        for (key, _) in &lists {
            reply["diagnostics"]["target"][*key] = json!([]);
        }
    }
    let mut remaining = INLINE_BYTES.saturating_sub(size(&reply));
    for (key, rows) in lists {
        let sample = reply["diagnostics"]["target"][key].as_array_mut().unwrap();
        for row in rows {
            let item = preview(&row);
            let cost = size(&item) + usize::from(!sample.is_empty());
            if cost <= remaining {
                remaining -= cost;
                sample.push(item);
            }
        }
    }
    reply
}
