use super::*;
use std::fs;

struct Sandbox(std::path::PathBuf);
impl Sandbox {
    fn new() -> Self {
        let instance = format!("desktop-output-tests-{}", std::process::id());
        let dir = std::env::temp_dir().join(crate::protocol::resource_id(&instance));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }
    fn input(&self) -> Value {
        json!({"captureDirectory":self.0})
    }
    fn check_full(&self, data: &Value, result: &Value) {
        let detail = &result["observationView"]["fullOutput"];
        let path = Path::new(detail["path"].as_str().unwrap());
        assert_eq!(path.parent(), Some(self.0.as_path()));
        let bytes = fs::read(path).unwrap();
        assert_eq!(json!(bytes.len()), detail["bytes"]);
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), *data);
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn small_and_unrelated_outputs_do_not_change_or_create_archives() {
    let dir = Sandbox::new();
    for data in [
        json!({"observationId":"small","elements":[],"accessibility":{"complete":false,"errors":[{"code":1}]}}),
        json!({"dispatched":true,"observationError":{"message":"target closed"}}),
        json!({"captureId":"one","contentRef":"p.png"}),
        json!({"windows":[{"title":"x".repeat(INLINE_BYTES)}]} ),
    ] {
        assert_eq!(for_host(data.clone(), &dir.input(), "fixture"), data);
    }
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
}

#[test]
fn exact_wire_boundary_and_late_semantic_action() {
    let dir = Sandbox::new();
    let mut data = json!({"observationId":"fixture","elements":[{"value":""}]});
    let fill = INLINE_BYTES - size(&data);
    data["elements"][0]["value"] = json!("z".repeat(fill));
    assert_eq!(size(&data), INLINE_BYTES);
    assert_eq!(for_host(data.clone(), &dir.input(), "fixture"), data);
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    data["elements"][0]["value"] = json!("z".repeat(fill + 1));
    let over = for_host(data.clone(), &dir.input(), "fixture");
    dir.check_full(&data, &over);
    let mut actions = vec![json!("AXShowMenu"); SAMPLE_COUNT];
    actions.push(json!("AXPress"));
    let item = element_preview(&json!({"elementId":"element:97","actions":actions}));
    assert_eq!(item["elementId"], "element:97");
    assert_eq!(item["actions"], json!(["AXPress"]));
}

#[test]
fn unicode_and_json_escaping_are_bounded_with_native_order_and_ids() {
    let dir = Sandbox::new();
    let text = "雪🦀\"\\\n\u{1f}".repeat(120);
    let nodes: Vec<_> = (0..750).map(|i| json!({"elementId":format!("element:{i}"),"title":format!("{text}:{i}"),"bounds":{"x":0,"y":if i<748 {800} else {10},"height":20,"width":30},"actions":if i==749 {vec!["AXPress"]} else {vec![]}})).collect();
    let errors: Vec<_> = (0..90)
        .map(|i| json!({"elementId":format!("element:{i}"),"attribute":"AXValue","message":text}))
        .collect();
    let raw = json!({"observationId":"old","dispatched":true,"action":"click","width":640,"height":400,"app":"target.exe","window":{"windowId":7},"contentRef":"capture.png","elements":nodes,"accessibility":{"complete":false,"errors":errors,"candidateErrors":errors}});
    let result = for_host(raw.clone(), &dir.input(), "fixture");
    dir.check_full(&raw, &result);
    assert!(size(&result) <= INLINE_BYTES);
    for k in [
        "window",
        "app",
        "dispatched",
        "observationId",
        "contentRef",
        "width",
        "height",
        "action",
    ] {
        assert_eq!(result[k], raw[k]);
    }
    let r = &result["observationView"];
    assert_eq!(r["totalElements"], 750);
    assert_eq!(r["diagnosticCounts"]["errors"], 90);
    assert_eq!(result["accessibility"]["complete"], false);
    assert_eq!(result["accessibility"]["inlineTruncated"], true);
    assert_eq!(result["accessibility"]["errors"][0]["attribute"], "AXValue");
    let shown = result["elements"].as_array().unwrap();
    assert!(shown.len() < 750);
    let indices: Vec<usize> = shown
        .iter()
        .map(|v| v["elementId"].as_str().unwrap()[8..].parse().unwrap())
        .collect();
    assert!(indices.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(indices[0], 0);
    assert_eq!(*indices.last().unwrap(), 749);
    let last = shown.last().unwrap();
    assert_eq!(last["bounds"], raw["elements"][749]["bounds"]);
    assert_eq!(last["actions"], json!(["AXPress"]));
    assert!(last["title"].as_str().unwrap().ends_with(":749"));
}

#[test]
fn failed_replies_preserve_the_cause_and_archive_only_over_budget() {
    let dir = Sandbox::new();
    let small = json!({"ok":false,"message":"No exact window match","diagnostics":{
        "phase":"computer:observe","native":{"permissions":{"accessibility":true,"screenCapture":true},"sharing":{"state":"inactive"}},
        "target":{"stage":"AXWindowIdentity","nativeCode":-25202,"windowId":17,"targetPid":31},
        "screenCaptureKit":null,"recovery":"Observe the correct window"}});
    assert_eq!(failure_for_host(small.clone(), &dir.input(), "qa"), small);
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    let row = json!({"index":0,"nativeCode":-25202,"message":"窗口🦀\"\n".repeat(90)});
    let mut large = small.clone();
    for key in ["errors", "candidateErrors"] {
        large["diagnostics"]["target"][key] = json!(vec![&row; 91]);
    }
    for input in [dir.input(), json!({})] {
        let out = failure_for_host(large.clone(), &input, "qa");
        assert!(size(&out) <= INLINE_BYTES);
        assert_eq!(out["ok"], false);
        assert_eq!(out["message"], small["message"]);
        assert!(out.get("data").is_none());
        let d = &out["diagnostics"];
        for key in ["phase", "native", "screenCaptureKit", "recovery"] {
            assert_eq!(d[key], small["diagnostics"][key]);
        }
        let view = &d["observationView"];
        for key in ["stage", "nativeCode", "targetPid", "windowId"] {
            assert_eq!(d["target"][key], small["diagnostics"]["target"][key]);
        }
        for key in ["errors", "candidateErrors"] {
            assert_eq!(view["diagnosticCounts"][key], 91);
            assert!((1..=SAMPLE_COUNT).contains(&d["target"][key].as_array().unwrap().len()));
            assert_eq!(d["target"][key][0]["nativeCode"], -25202);
        }
        if input == dir.input() {
            dir.check_full(&large, d);
        } else {
            assert!(view["fullOutput"].is_null());
            assert!(view["archiveError"]["message"].is_string());
        }
    }
    // A large failure can also be a scalar message without even one AX row.
    large["message"] = json!("雪\n".repeat(INLINE_BYTES));
    large["diagnostics"]["screenCaptureKit"] = json!({"stage":"startCapture","nativeDomain":"SCStreamErrorDomain","nativeCode":-3801,"message":"denied"});
    let out = failure_for_host(large.clone(), &dir.input(), "qa");
    assert!(size(&out) <= INLINE_BYTES);
    assert_eq!(
        out["diagnostics"]["screenCaptureKit"],
        large["diagnostics"]["screenCaptureKit"]
    );
    assert_eq!(out["diagnostics"]["native"]["sharing"]["state"], "inactive");
    dir.check_full(&large, &out["diagnostics"]);
}

#[test]
fn compacted_failure_preserves_observation_ownership_without_inferring_it_from_sharing() {
    for bound in [Some(false), Some(true), None] {
        let mut failure = json!({"ok":false,"message":"x".repeat(INLINE_BYTES + 1),
            "diagnostics":{"phase":"computer:observe","native":{"sharing":{"state":"inactive"}}}});
        if let Some(value) = bound {
            failure["diagnostics"]["native"]["hasBoundObservation"] = json!(value);
        }
        let reply = failure_for_host(failure, &json!({}), "qa");
        assert!(size(&reply) <= INLINE_BYTES);
        assert_eq!(reply["ok"], false);
        let native = &reply["diagnostics"]["native"];
        assert_eq!(native["sharing"]["state"], "inactive");
        assert_eq!(
            native.get("hasBoundObservation").cloned(),
            bound.map(Value::Bool)
        );
    }
}

#[test]
fn enabled_visible_button_survives_competition_with_disabled_press_targets() {
    let dir = Sandbox::new();
    let mut nodes: Vec<_> = (0..240).map(|i| json!({"elementId":format!("element:{i}"), "title":"gray".repeat(240), "bounds":{"x":4,"y":4,"width":25,"height":20}, "actions":["AXPress"], "enabled":false})).collect();
    let mut enabled = nodes.last().unwrap().clone();
    enabled["elementId"] = json!("element:240");
    enabled.as_object_mut().unwrap().remove("enabled"); // Native sparse flag, as on Windows.
    nodes.push(enabled);
    let data = json!({"observationId":"mac","width":640,"height":480,"elements":nodes});
    let out = for_host(data.clone(), &dir.input(), "qa");
    dir.check_full(&data, &out);
    let kept = out["elements"].as_array().unwrap();
    assert!(kept.len() < 241 && kept.len() > 1);
    assert_eq!(kept[0]["enabled"], false);
    assert_eq!(kept.last().unwrap()["elementId"], "element:240");
}

#[test]
fn oversized_verification_and_missing_archive_cannot_reverse_dispatch() {
    let dir = Sandbox::new();
    let data = json!({"action":"setValue","dispatched":true,"valueVerification":{"matched":false,"expected":"雪".repeat(30000),"actual":"x"},"actionError":{"message":"write did not match"},"observationError":{"message":"window closed"}});
    let ok = for_host(data.clone(), &dir.input(), "fixture");
    dir.check_full(&data, &ok);
    let blocked = dir.0.join("not-a-directory");
    fs::write(&blocked, b"fixture").unwrap();
    for input in [dir.input(), json!({}), json!({"captureDirectory":blocked})] {
        let out = for_host(data.clone(), &input, "fixture");
        assert_eq!(out["dispatched"], true);
        assert_eq!(out["valueVerification"]["matched"], false);
        assert_eq!(out["actionError"], data["actionError"]);
        assert_eq!(out["observationError"], data["observationError"]);
        assert!(size(&out) < INLINE_BYTES);
        if input != dir.input() {
            assert!(out["observationView"]["fullOutput"].is_null());
            assert!(out["observationView"]["archiveError"]["message"].is_string());
        }
    }
    let fresh = dir.0.join("attempt-without-frame");
    let saved = for_host(data.clone(), &json!({"captureDirectory":fresh}), "fixture");
    assert!(Path::new(
        saved["observationView"]["fullOutput"]["path"]
            .as_str()
            .unwrap()
    )
    .is_file());
    let no_original = json!({"observationId":"new","dispatched":true,"elements":[{"value":"x".repeat(INLINE_BYTES)}],"accessibility":{"complete":true,"errors":[]}});
    let partial = for_host(no_original, &json!({}), "fixture");
    assert_eq!(partial["dispatched"], true);
    assert_eq!(partial["accessibility"]["complete"], true);
    assert!(partial["observationError"]["message"].is_string());
    assert!(partial["observationView"]["fullOutput"].is_null());
}
