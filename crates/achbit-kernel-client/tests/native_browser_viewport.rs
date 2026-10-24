#[path = "../../../shells/shared/native_browser/viewport.rs"]
mod viewport;
use serde_json::json;
use viewport::Viewport;

#[test]
fn fixed_layout_survives_sidebars_and_expansion() {
    let viewport = Viewport::default();
    assert_eq!(viewport.initial_size(), (1280.0, 800.0));
    for available in [
        [809.0, 100.0, 480.0, 820.0],
        [20.0, 100.0, 1280.0, 820.0],
        [0.0, 0.0, 1920.0, 1080.0],
    ] {
        let ([x, y, width, height], scale) = viewport.fit(available);
        assert_eq!((width / scale, height / scale), (1280.0, 800.0));
        assert_eq!(y, available[1]);
        assert!(x >= available[0] && x + width <= available[0] + available[2]);
        assert!(height <= available[3]);
    }
    let adaptive = Viewport::parse(&json!({"mode":"adaptive"})).unwrap();
    assert_eq!(
        adaptive.fit([12.0, 32.0, 480.0, 820.0]),
        ([12.0, 32.0, 480.0, 820.0], 1.0)
    );
    let phone = Viewport::parse(&json!({"mode":"fixed","width":390,"height":844})).unwrap();
    let (bounds, scale) = phone.fit([0.0, 0.0, 480.0, 600.0]);
    assert!((bounds[2] / scale - 390.0).abs() < 0.001);
    assert!((bounds[3] / scale - 844.0).abs() < 0.001);
}

#[test]
fn viewport_rejects_incomplete_or_ambiguous_policies() {
    for value in [
        json!(null),
        json!({"mode":"fixed"}),
        json!({"mode":"adaptive","width":1280}),
        json!({"mode":"fixed","width":0,"height":800}),
        json!({"mode":"fixed","width":8193,"height":800}),
        json!({"mode":"fixed","width":1280.5,"height":800}),
        json!({"mode":"other"}),
    ] {
        assert!(Viewport::parse(&value).is_err(), "{value}");
    }
}
