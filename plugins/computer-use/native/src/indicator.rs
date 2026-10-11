//! Noninteractive, window-relative feedback for an active native call.
//! No floating global panel, no focus changes, no model-controlled visibility.
use crate::driver::{window_snapshot, Point};
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use serde_json::Value;
use std::cell::RefCell;

struct Indicator {
    window: u32,
    badge: Retained<AnyObject>,
    cursor: Option<Retained<AnyObject>>,
    cursor_offset: Option<Point>,
    size: f64,
    inset: Point,
}
thread_local! { static ACTIVE: RefCell<Option<Indicator>> = const { RefCell::new(None) }; }

unsafe fn panel(symbol: &str, size: f64, color: &[Value]) -> Result<Retained<AnyObject>, String> {
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(size, size));
    let panel: *mut AnyObject = msg_send![class!(NSPanel), alloc];
    let panel: *mut AnyObject = msg_send![panel, initWithContentRect:frame, styleMask:128_usize, backing:2_usize, defer:false];
    let panel = Retained::from_raw(panel).ok_or("Could not create the Computer Use indicator")?;
    let clear: *mut AnyObject = msg_send![class!(NSColor), clearColor];
    let _: () = msg_send![&*panel, setOpaque:false];
    let _: () = msg_send![&*panel, setBackgroundColor:clear];
    let _: () = msg_send![&*panel, setIgnoresMouseEvents:true];
    let _: () = msg_send![&*panel, setHidesOnDeactivate:false];
    let _: () = msg_send![&*panel, setReleasedWhenClosed:false];
    let _: () = msg_send![&*panel, setLevel:0_isize];
    let _: () = msg_send![&*panel, setSharingType:0_usize];
    let view: *mut AnyObject = msg_send![class!(NSImageView), alloc];
    let view: *mut AnyObject = msg_send![view, initWithFrame:frame];
    let view = Retained::from_raw(view).ok_or("Could not create the Computer Use icon")?;
    let name = NSString::from_str(symbol);
    let image: *mut AnyObject = msg_send![class!(NSImage), imageWithSystemSymbolName:&*name, accessibilityDescription:std::ptr::null::<NSString>()];
    if image.is_null() {
        return Err(format!("Unknown indicator symbol: {symbol}"));
    }
    let _: () = msg_send![&*view, setImage:image];
    let color: *mut AnyObject = msg_send![class!(NSColor), colorWithCalibratedRed:color[0].as_f64().ok_or("Invalid indicator red")?, green:color[1].as_f64().ok_or("Invalid indicator green")?, blue:color[2].as_f64().ok_or("Invalid indicator blue")?, alpha:1.0_f64];
    let _: () = msg_send![&*view, setContentTintColor:color];
    let _: () = msg_send![&*panel, setContentView:&*view];
    Ok(panel)
}

pub unsafe fn show(window: u32, cursor: Option<Point>) -> Result<(), String> {
    hide();
    let (_, bounds) = window_snapshot(window)?;
    let resource = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .and_then(|p| p.parent())
        .ok_or("Invalid component bundle")?
        .join("Resources/indicator.json");
    let config: Value =
        serde_json::from_slice(&std::fs::read(resource).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let number = |key| {
        config[key]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .ok_or_else(|| format!("Invalid indicator {key}"))
    };
    let size = number("size")?;
    if size == 0.0 {
        return Err("Indicator size must be positive".into());
    }
    let color = config["color"]
        .as_array()
        .filter(|v| {
            v.len() == 3
                && v.iter()
                    .all(|c| c.as_f64().is_some_and(|n| (0.0..=1.0).contains(&n)))
        })
        .ok_or("Invalid indicator color")?;
    let badge = panel(
        config["symbol"]
            .as_str()
            .ok_or("Missing indicator symbol")?,
        size,
        color,
    )?;
    let cursor_panel = cursor
        .map(|_| panel("cursorarrow", size, color))
        .transpose()?;
    let inset = Point {
        x: number("insetX")?,
        y: number("insetY")?,
    };
    ACTIVE.with(|slot| {
        *slot.borrow_mut() = Some(Indicator {
            window,
            badge,
            cursor: cursor_panel,
            cursor_offset: cursor.map(|p| Point {
                x: p.x - bounds.origin.x,
                y: p.y - bounds.origin.y,
            }),
            size,
            inset,
        })
    });
    refresh();
    Ok(())
}

pub fn hide() {
    ACTIVE.with(|slot| {
        if let Some(active) = slot.borrow_mut().take() {
            unsafe {
                let _: () = msg_send![&*active.badge, orderOut:std::ptr::null::<AnyObject>()];
                if let Some(cursor) = active.cursor {
                    let _: () = msg_send![&*cursor, orderOut:std::ptr::null::<AnyObject>()];
                }
            }
        }
    });
}

pub fn refresh() {
    let valid = ACTIVE.with(|slot| -> Result<(), String> {
        unsafe {
            let active = slot.borrow();
            let Some(active) = active.as_ref() else {
                return Ok(());
            };
            let (_, bounds) = window_snapshot(active.window)?;
            // AppKit coordinates use the primary screen's bottom-left as origin.
            let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
            let screen: *mut AnyObject = msg_send![screens, firstObject];
            if screen.is_null() {
                return Err("Display is unavailable".into());
            }
            let primary: NSRect = msg_send![screen, frame];
            let place = |panel: &AnyObject, offset: Point| {
                if offset.x < 0.0
                    || offset.y < 0.0
                    || offset.x + active.size > bounds.size.width
                    || offset.y + active.size > bounds.size.height
                {
                    let _: () = msg_send![panel, orderOut:std::ptr::null::<AnyObject>()];
                    return;
                }
                let origin = NSPoint::new(
                    bounds.origin.x + offset.x,
                    primary.size.height - bounds.origin.y - offset.y - active.size,
                );
                let _: () = msg_send![panel, setFrameOrigin:origin];
                let _: () =
                    msg_send![panel, orderWindow:1_isize, relativeTo:active.window as isize];
            };
            place(&active.badge, active.inset);
            if let (Some(cursor), Some(offset)) = (&active.cursor, active.cursor_offset) {
                place(cursor, offset);
            }
            Ok(())
        }
    });
    if valid.is_err() {
        hide();
    }
}
