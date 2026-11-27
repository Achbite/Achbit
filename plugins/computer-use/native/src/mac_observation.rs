//! macOS observation contract. Logical window points exist independently of a captured image.
use crate::protocol::{self, Bounds};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Ax,
    AxWithImage,
    Pixels,
}

impl Kind {
    pub fn parse(input: &Value) -> Result<Self, String> {
        let screenshot = input
            .get("includeScreenshot")
            .map(|v| v.as_bool().ok_or("includeScreenshot must be boolean"))
            .transpose()?;
        match input.get("observationType").map(Value::as_str) {
            None | Some(Some("accessibility")) => Ok(if screenshot == Some(true) {
                Self::AxWithImage
            } else {
                Self::Ax
            }),
            Some(Some("pixels")) if screenshot != Some(false) => Ok(Self::Pixels),
            Some(Some("pixels")) => Err("Pixel observation requires an image".into()),
            _ => Err("Unknown observationType".into()),
        }
    }
}

/// Only the needed preflight is consulted. An already selected picker filter
/// is not authority to capture any other target.
pub fn check_access(
    kind: Kind,
    input_action: bool,
    picker_grant: bool,
    ax: impl FnOnce() -> bool,
    screen: impl FnOnce() -> bool,
) -> Result<(), String> {
    if (input_action || kind != Kind::Pixels) && !ax() {
        return Err("macOS 辅助功能授权未被当前 Computer Use 辅助 App识别。请先使用 computer.control status 核对进程和应用身份；系统设置中的同名开关不能确认当前实例的状态。".into());
    }
    if kind != Kind::Ax && !picker_grant && !screen() {
        return Err("macOS screen recording access is not granted to the executing Computer Use App; inspect computer.control status for its identity".into());
    }
    Ok(())
}

pub fn desktop_point(
    input: &Value,
    x: &str,
    y: &str,
    window: Bounds,
    image: Option<(f64, f64)>,
) -> Result<(f64, f64), String> {
    match input.get("coordinateSpace").map(Value::as_str) {
        Some(Some("windowPoints")) => {
            let px = input[x].as_f64().ok_or("Missing window x")?;
            let py = input[y].as_f64().ok_or("Missing window y")?;
            if !(0.0..window.width).contains(&px) || !(0.0..window.height).contains(&py) {
                return Err("Point is outside the observed window (logical points)".into());
            }
            Ok((window.x + px, window.y + py))
        }
        None | Some(Some("imagePixels")) => protocol::desktop_point(
            input,
            x,
            y,
            image
                .ok_or("No screenshot in this observation; specify coordinateSpace=windowPoints")?,
            window,
        ),
        _ => Err("coordinateSpace must be windowPoints or imagePixels".into()),
    }
}

pub fn project_elements(
    elements: &mut [Value],
    window: Bounds,
    image: Option<(f64, f64)>,
) -> Result<(), String> {
    for item in elements {
        let Some(rect) = item.get("bounds") else {
            continue;
        };
        let number = |key: &str| {
            rect[key]
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or("Invalid AX bounds")
        };
        let local = Bounds {
            x: number("x")? - window.x,
            y: number("y")? - window.y,
            width: number("width")?,
            height: number("height")?,
        };
        let as_json = |r: Bounds| json!({"x":r.x,"y":r.y,"width":r.width,"height":r.height});
        item["boundsWindowPoints"] = as_json(local);
        let cx = local.x + local.width / 2.0;
        let cy = local.y + local.height / 2.0;
        if local.width > 0.0
            && local.height > 0.0
            && (0.0..window.width).contains(&cx)
            && (0.0..window.height).contains(&cy)
        {
            item["centerWindowPoints"] = json!({"x":cx,"y":cy});
        }
        item["bounds"] = if let Some((w, h)) = image {
            let (sx, sy) = (w / window.width, h / window.height);
            let rect = as_json(Bounds {
                x: local.x * sx,
                y: local.y * sy,
                width: local.width * sx,
                height: local.height * sy,
            });
            item["boundsImagePixels"] = rect.clone();
            rect
        } else {
            as_json(local)
        };
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permission_matrix_separates_read_only_pixels_ax_and_input() {
        for ax in [false, true] {
            for screen in [false, true] {
                assert_eq!(
                    check_access(
                        Kind::Ax,
                        false,
                        false,
                        || ax,
                        || panic!("AX queried screen preflight")
                    )
                    .is_ok(),
                    ax
                );
                assert_eq!(
                    check_access(
                        Kind::Ax,
                        true,
                        false,
                        || ax,
                        || panic!("AX input queried screen preflight")
                    )
                    .is_ok(),
                    ax
                );
                assert_eq!(
                    check_access(Kind::AxWithImage, false, false, || ax, || screen).is_ok(),
                    ax && screen
                );
                assert_eq!(
                    check_access(
                        Kind::Pixels,
                        false,
                        false,
                        || panic!("pixel read queried AX"),
                        || screen
                    )
                    .is_ok(),
                    screen
                );
                assert_eq!(
                    check_access(Kind::Pixels, true, false, || ax, || screen).is_ok(),
                    ax && screen
                );
            }
        }
    }

    #[test]
    fn an_existing_user_filter_never_grants_input_access() {
        assert!(check_access(
            Kind::Pixels,
            false,
            true,
            || false,
            || panic!("user filter queried process preflight")
        )
        .is_ok());
        assert!(check_access(Kind::Pixels, true, true, || false, || true).is_err());
    }

    #[test]
    fn no_implicit_capture_and_pixels_cannot_be_downgraded() {
        assert_eq!(Kind::parse(&json!({})).unwrap(), Kind::Ax);
        assert_eq!(
            Kind::parse(&json!({"observationType":"accessibility"})).unwrap(),
            Kind::Ax
        );
        assert_eq!(
            Kind::parse(&json!({"includeScreenshot":true})).unwrap(),
            Kind::AxWithImage
        );
        assert_eq!(
            Kind::parse(&json!({"observationType":"pixels"})).unwrap(),
            Kind::Pixels
        );
        for bad in [
            json!({"includeScreenshot":"false"}),
            json!({"observationType":"pixels","includeScreenshot":false}),
            json!({"observationType":null}),
        ] {
            assert!(Kind::parse(&bad).is_err());
        }
    }
    #[test]
    fn points_and_image_pixels_bind_to_the_exact_observation() {
        for origin in [100.0, -1500.0] {
            let window = Bounds {
                x: origin,
                y: 530.0,
                width: 660.0,
                height: 482.0,
            };
            for image in [
                None,
                Some((660.0, 482.0)),
                Some((1320.0, 964.0)),
                Some((500.0, 365.0)),
            ] {
                let mut items =
                    vec![json!({"bounds":{"x":origin+3.0,"y":591.0,"width":162.0,"height":29.0}})];
                project_elements(&mut items, window, image).unwrap();
                let point = &items[0]["centerWindowPoints"];
                assert_eq!(point, &json!({"x":84.0,"y":75.5}));
                assert_eq!(items[0].get("boundsImagePixels").is_some(), image.is_some());
                let mut args = point.clone();
                args["coordinateSpace"] = json!("windowPoints");
                assert_eq!(
                    desktop_point(&args, "x", "y", window, image).unwrap(),
                    (origin + 84.0, 605.5)
                );
                if let Some((w, h)) = image {
                    let args = json!({"x":84.0*w/660.0,"y":75.5*h/482.0});
                    assert_eq!(
                        desktop_point(&args, "x", "y", window, image).unwrap(),
                        (origin + 84.0, 605.5)
                    );
                } else {
                    assert!(desktop_point(point, "x", "y", window, image).is_err());
                }
                assert!(desktop_point(
                    &json!({"coordinateSpace":"windowPoints","x":660,"y":1}),
                    "x",
                    "y",
                    window,
                    image
                )
                .is_err());
            }
        }
    }
}
