//! Foreground mouse and keyboard input through SendInput. Coordinates are
//! screenshot pixels of the current observation.
use crate::protocol::{self, Bounds};
use serde_json::Value;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;
const VK_LWIN: u16 = 0x5B;

#[derive(Debug, PartialEq)]
pub struct Key {
    pub code: u16,
    pub extended: bool,
}

/// Named keys with ctrl/shift/alt/win modifiers. `cmd` is a macOS modifier and
/// is rejected rather than guessed, because Windows has no single equivalent.
pub fn parse_key(value: &str) -> Result<(Vec<u16>, Key), String> {
    let mut parts: Vec<&str> = value.split('+').map(str::trim).collect();
    let name = parts
        .pop()
        .filter(|name| !name.is_empty())
        .ok_or("Missing key")?
        .to_ascii_lowercase();
    let mut modifiers = Vec::new();
    for part in parts {
        let code = match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => VK_CONTROL,
            "shift" => VK_SHIFT,
            "alt" => VK_MENU,
            "win" | "windows" | "super" => VK_LWIN,
            "cmd" | "command" | "option" => {
                return Err(format!(
                    "Modifier {part} is a macOS key; on Windows use ctrl, alt, shift or win"
                ))
            }
            _ => return Err(format!("Unsupported modifier: {part}")),
        };
        if !modifiers.contains(&code) {
            modifiers.push(code);
        }
    }
    let (code, extended) = match name.as_str() {
        "return" | "enter" => (0x0D, false),
        "tab" => (0x09, false),
        "space" => (0x20, false),
        "escape" | "esc" => (0x1B, false),
        "backspace" => (0x08, false),
        "delete" | "del" => (0x2E, true),
        "insert" => (0x2D, true),
        "left" => (0x25, true),
        "up" => (0x26, true),
        "right" => (0x27, true),
        "down" => (0x28, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "pageup" => (0x21, true),
        "pagedown" => (0x22, true),
        single if single.len() == 1 && single.as_bytes()[0].is_ascii_alphanumeric() => {
            (single.as_bytes()[0].to_ascii_uppercase() as u16, false)
        }
        function if function.starts_with('f') => match function[1..].parse::<u16>() {
            Ok(number @ 1..=12) => (0x6F + number, false),
            _ => return Err(format!("Unsupported key: {name}; use type for text")),
        },
        _ => return Err(format!("Unsupported key: {name}; use type for text")),
    };
    Ok((modifiers, Key { code, extended }))
}

fn keyboard(code: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(code),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Absolute moves are normalized to the virtual desktop spanning every monitor.
fn move_to((x, y): (f64, f64)) -> INPUT {
    let (left, top, width, height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2),
        )
    };
    let normalize = |value: f64, origin: i32, size: i32| {
        ((value - origin as f64) * 65535.0 / (size - 1) as f64).round() as i32
    };
    mouse(
        normalize(x, left, width),
        normalize(y, top, height),
        0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
    )
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(format!(
            "SendInput dispatched {sent} of {} events ({}); part of the input may already have taken effect. Observe before deciding any further action.",
            inputs.len(),
            windows::core::Error::from_win32().message()
        ));
    }
    Ok(())
}

pub fn dispatch(
    input: &Value,
    action: &str,
    image: (f64, f64),
    bounds: Bounds,
) -> Result<Option<(f64, f64)>, String> {
    let point = |x: &str, y: &str| protocol::desktop_point(input, x, y, image, bounds);
    let mut events = Vec::new();
    let mut position = None;
    match action {
        "click" => {
            position = Some(point("x", "y")?);
            events.push(move_to(point("x", "y")?));
            events.push(mouse(0, 0, 0, MOUSEEVENTF_LEFTDOWN));
            events.push(mouse(0, 0, 0, MOUSEEVENTF_LEFTUP));
        }
        "drag" => {
            let (from, to) = (point("x", "y")?, point("toX", "toY")?);
            position = Some(to);
            events.push(move_to(from));
            events.push(mouse(0, 0, 0, MOUSEEVENTF_LEFTDOWN));
            for step in 1..=12 {
                let amount = step as f64 / 12.0;
                events.push(move_to((
                    from.0 + (to.0 - from.0) * amount,
                    from.1 + (to.1 - from.1) * amount,
                )));
            }
            events.push(mouse(0, 0, 0, MOUSEEVENTF_LEFTUP));
        }
        "key" => {
            let (modifiers, key) = parse_key(input["key"].as_str().ok_or("Missing key")?)?;
            let extended = if key.extended {
                KEYEVENTF_EXTENDEDKEY
            } else {
                KEYBD_EVENT_FLAGS(0)
            };
            events.extend(
                modifiers
                    .iter()
                    .map(|code| keyboard(*code, 0, KEYBD_EVENT_FLAGS(0))),
            );
            events.push(keyboard(key.code, 0, extended));
            events.push(keyboard(key.code, 0, extended | KEYEVENTF_KEYUP));
            events.extend(
                modifiers
                    .iter()
                    .rev()
                    .map(|code| keyboard(*code, 0, KEYEVENTF_KEYUP)),
            );
        }
        "type" => {
            let text = input["text"].as_str().ok_or("Missing text")?;
            if text.len() > 8192 {
                return Err("Text exceeds 8192 bytes".into());
            }
            for unit in text.encode_utf16() {
                events.push(keyboard(0, unit, KEYEVENTF_UNICODE));
                events.push(keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
        }
        "scroll" => {
            position = Some((
                bounds.x + bounds.width / 2.0,
                bounds.y + bounds.height / 2.0,
            ));
            let delta = |field: &str| {
                input[field]
                    .as_i64()
                    .and_then(|value| i32::try_from(value).ok())
                    .ok_or_else(|| format!("{field} must be a 32-bit integer"))
            };
            let (dx, dy) = (delta("deltaX")?, delta("deltaY")?);
            // The wheel targets the window under the cursor: the observed window's centre.
            events.push(move_to((
                bounds.x + bounds.width / 2.0,
                bounds.y + bounds.height / 2.0,
            )));
            if dy != 0 {
                events.push(mouse(0, 0, dy, MOUSEEVENTF_WHEEL));
            }
            if dx != 0 {
                events.push(mouse(0, 0, dx, MOUSEEVENTF_HWHEEL));
            }
        }
        _ => return Err("Unsupported computer action".into()),
    }
    send(&events)?;
    Ok(position)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_use_windows_modifiers_and_reject_mac_modifiers() {
        let (modifiers, key) = parse_key("ctrl+shift+s").unwrap();
        assert_eq!(modifiers, vec![VK_CONTROL, VK_SHIFT]);
        assert_eq!(
            key,
            Key {
                code: b'S' as u16,
                extended: false
            }
        );
        assert_eq!(
            parse_key("Left").unwrap().1,
            Key {
                code: 0x25,
                extended: true
            }
        );
        assert_eq!(parse_key("win+d").unwrap().0, vec![VK_LWIN]);
        assert_eq!(parse_key("F5").unwrap().1.code, 0x74);
        assert!(parse_key("cmd+a").unwrap_err().contains("ctrl"));
        assert!(parse_key("F13").is_err());
        assert!(parse_key("ctrl+").is_err());
        assert!(parse_key("hyper+a").is_err());
    }
}
