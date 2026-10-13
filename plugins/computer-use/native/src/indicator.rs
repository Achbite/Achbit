//! Nonactivating pointer feedback. The OS owns the persistent sharing indicator.
use crate::driver::{window_snapshot, Point};
use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use std::{
    cell::RefCell,
    time::{Duration, Instant},
};

struct Feedback {
    window: u32,
    generation: u64,
    cursor: Retained<AnyObject>,
    halo: Retained<AnyObject>,
    offset: Point,
    expires: Instant,
}
thread_local! { static ACTIVE: RefCell<Option<Feedback>> = const { RefCell::new(None) }; }

unsafe fn panel(symbol: &str, size: f64, alpha: f64) -> Result<Retained<AnyObject>, String> {
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(size, size));
    let panel: *mut AnyObject = msg_send![class!(NSPanel), alloc];
    let panel: *mut AnyObject = msg_send![panel, initWithContentRect:frame, styleMask:128_usize, backing:2_usize, defer:false];
    let panel = Retained::from_raw(panel).ok_or("Could not create Computer Use pointer")?;
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
    let view = Retained::from_raw(view).ok_or("Could not create pointer image view")?;
    let name = NSString::from_str(symbol);
    let image: *mut AnyObject = msg_send![class!(NSImage), imageWithSystemSymbolName:&*name, accessibilityDescription:std::ptr::null::<NSString>()];
    if image.is_null() {
        return Err(format!("Unknown pointer symbol: {symbol}"));
    }
    let _: () = msg_send![&*view, setImage:image];
    let color: *mut AnyObject = msg_send![class!(NSColor), colorWithCalibratedRed:0.2_f64, green:0.38_f64, blue:0.94_f64, alpha:alpha];
    let _: () = msg_send![&*view, setContentTintColor:color];
    let _: () = msg_send![&*panel, setContentView:&*view];
    Ok(panel)
}

pub unsafe fn show(window: u32, cursor: Option<Point>, generation: u64) -> Result<(), String> {
    let Some(point) = cursor else {
        return Ok(());
    };
    let (_, bounds) = window_snapshot(window)?;
    let mut feedback = ACTIVE.with(|slot| slot.borrow_mut().take());
    if feedback
        .as_ref()
        .is_some_and(|value| value.window != window || value.generation != generation)
    {
        if let Some(value) = feedback.take() {
            dismiss(value);
        }
    }
    let mut feedback = match feedback {
        Some(value) => value,
        None => Feedback {
            window,
            generation,
            cursor: panel("cursorarrow", 26.0, 1.0)?,
            halo: panel("circle.fill", 38.0, 0.22)?,
            offset: Point { x: 0.0, y: 0.0 },
            expires: Instant::now(),
        },
    };
    feedback.offset = Point {
        x: point.x - bounds.origin.x,
        y: point.y - bounds.origin.y,
    };
    feedback.expires = Instant::now() + Duration::from_millis(900);
    ACTIVE.with(|slot| *slot.borrow_mut() = Some(feedback));
    refresh();
    Ok(())
}

fn dismiss(feedback: Feedback) {
    unsafe {
        let _: () = msg_send![&*feedback.cursor, orderOut:std::ptr::null::<AnyObject>()];
        let _: () = msg_send![&*feedback.halo, orderOut:std::ptr::null::<AnyObject>()];
    }
}

pub fn hide_window(window: u32, generation: u64) {
    let matches = ACTIVE.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|value| value.window == window && value.generation == generation)
    });
    if matches {
        hide();
    }
}

pub fn hide() {
    if let Some(feedback) = ACTIVE.with(|slot| slot.borrow_mut().take()) {
        dismiss(feedback);
    }
}

pub fn refresh() {
    let valid = ACTIVE.with(|slot| -> Result<(), String> {
        unsafe {
            let active = slot.borrow();
            let Some(active) = active.as_ref() else {
                return Ok(());
            };
            let (_, bounds) = window_snapshot(active.window)?;
            let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
            let screen: *mut AnyObject = msg_send![screens, firstObject];
            if screen.is_null() {
                return Err("Display is unavailable".into());
            }
            let primary: NSRect = msg_send![screen, frame];
            for (panel, size, inset) in [(&active.halo, 38.0, 19.0), (&active.cursor, 26.0, 3.0)] {
                if size == 38.0 && Instant::now() >= active.expires {
                    let _: () = msg_send![&**panel, orderOut:std::ptr::null::<AnyObject>()];
                    continue;
                }
                let origin = NSPoint::new(
                    bounds.origin.x + active.offset.x - inset,
                    primary.size.height - bounds.origin.y - active.offset.y + inset - size,
                );
                let _: () = msg_send![&**panel, setFrameOrigin:origin];
                let _: () =
                    msg_send![&**panel, orderWindow:1_isize, relativeTo:active.window as isize];
                let _: () = msg_send![&**panel, displayIfNeeded];
            }
            Ok(())
        }
    });
    if valid.is_err() {
        hide();
    }
}
