//! Debug observations are scoped to the file picker owned by this process.
//! Only the original IFileDialog completion publishes selected/cancelled paths.
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use windows::{
    core::{Interface, BSTR},
    Win32::{
        Foundation::{HWND, LPARAM, RECT},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED,
            },
            Threading::GetCurrentThreadId,
        },
        UI::{Accessibility::*, WindowsAndMessaging::*},
    },
};

#[derive(Clone)]
struct Active {
    id: String,
    parent: isize,
    thread: u32,
    title: String,
}
static NEXT: AtomicU64 = AtomicU64::new(1);
static STATE: Mutex<(Option<Active>, Value)> = Mutex::new((None, Value::Null));

pub(super) fn opened(parent: HWND, title: &str) -> Result<String, String> {
    let mut state = STATE.lock().map_err(|_| "debug_dialog_state_unavailable")?;
    if state.0.is_some() {
        return Err("debug_native_dialog_already_open".into());
    }
    let id = format!("native-dialog-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    state.0 = Some(Active {
        id: id.clone(),
        parent: parent.0 as isize,
        thread: unsafe { GetCurrentThreadId() },
        title: title.into(),
    });
    Ok(id)
}

pub(super) fn completed(id: &str, result: &Result<Option<Vec<PathBuf>>, String>) {
    if let Ok(mut state) = STATE.lock() {
        if !state.0.as_ref().is_some_and(|active| active.id == id) {
            return;
        }
        state.1 = match result {
            Ok(Some(paths)) => json!({"id":id,"status":"selected","paths":paths}),
            Ok(None) => json!({"id":id,"status":"cancelled"}),
            Err(error) => json!({"id":id,"status":"failed","error":error}),
        };
        state.0 = None;
    }
}

fn active(args: &Value) -> Result<Option<Active>, String> {
    let current = STATE
        .lock()
        .map_err(|_| "debug_dialog_state_unavailable")?
        .0
        .clone();
    if let Some(current) = &current {
        if args["dialogId"].as_str().is_some_and(|id| id != current.id) {
            return Err("debug_native_dialog_identity_mismatch".into());
        }
    }
    Ok(current)
}

fn window(current: &Active) -> Result<HWND, String> {
    struct Search {
        parent: isize,
        found: Vec<isize>,
    }
    unsafe extern "system" fn visit(hwnd: HWND, param: LPARAM) -> windows::core::BOOL {
        let search = &mut *(param.0 as *mut Search);
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut class = [0u16; 64];
        let len = GetClassNameW(hwnd, &mut class);
        if pid == std::process::id()
            && IsWindowVisible(hwnd).as_bool()
            && GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| owner.0 as isize == search.parent)
            && String::from_utf16_lossy(&class[..len as usize]) == "#32770"
        {
            search.found.push(hwnd.0 as isize);
        }
        true.into()
    }
    let mut search = Search {
        parent: current.parent,
        found: vec![],
    };
    unsafe {
        EnumThreadWindows(
            current.thread,
            Some(visit),
            LPARAM(&mut search as *mut _ as isize),
        )
    }
    .ok()
    .map_err(|error| error.to_string())?;
    match search.found.as_slice() {
        [hwnd] => Ok(HWND(*hwnd as *mut _)),
        [] => Err("debug_native_dialog_window_not_ready".into()),
        _ => Err("debug_native_dialog_window_ambiguous".into()),
    }
}

fn observed_window(args: &Value) -> Result<Option<(Active, HWND)>, String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut expected = json!({"dialogId":args["dialogId"]});
    loop {
        let Some(current) = active(&expected)? else {
            return Ok(None);
        };
        expected["dialogId"] = json!(current.id);
        match window(&current) {
            Ok(hwnd) => return Ok(Some((current, hwnd))),
            // IFileDialog registers before Show creates its HWND, and destroys
            // the HWND before Show returns. Wait only for that observed native
            // transition; never replay an action or hide a different error.
            Err(error)
                if error == "debug_native_dialog_window_not_ready" && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(error) => return Err(error),
        }
    }
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}
fn optional<T>(result: windows::core::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code().is_ok() => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
unsafe fn at(
    walker: &IUIAutomationTreeWalker,
    root: &IUIAutomationElement,
    path: &[usize],
) -> Result<IUIAutomationElement, String> {
    let mut item = root.clone();
    for &index in path {
        item = optional(walker.GetFirstChildElement(&item))?.ok_or("debug_dialog_node_missing")?;
        for _ in 0..index {
            item = optional(walker.GetNextSiblingElement(&item))?
                .ok_or("debug_dialog_node_missing")?;
        }
    }
    Ok(item)
}
fn node_path(args: &Value) -> Result<Vec<usize>, String> {
    let path: Vec<usize> = serde_json::from_value(args["nodePath"].clone())
        .map_err(|error| format!("debug_dialog_node_path_required: {error}"))?;
    if path.len() > 32 || path.iter().any(|index| *index >= 512) {
        return Err("debug_dialog_node_path_invalid".into());
    }
    Ok(path)
}

pub fn command(name: &str, args: &Value, parent: isize) -> Result<Value, String> {
    if name == "menus" || name == "menu" {
        return unsafe { menu_command(name, args, HWND(parent as *mut _)) };
    }
    let observed = if name == "inspect" {
        observed_window(args)?
    } else {
        active(args)?
            .map(|current| window(&current).map(|hwnd| (current, hwnd)))
            .transpose()?
    };
    let Some((current, hwnd)) = observed else {
        return if name == "inspect" {
            Ok(
                json!({"status":"closed","lastResult":STATE.lock().map_err(|_| "debug_dialog_state_unavailable")?.1}),
            )
        } else {
            Err("debug_native_dialog_not_open".into())
        };
    };
    if name == "cancel" {
        unsafe { PostMessageW(Some(hwnd), WM_CLOSE, Default::default(), Default::default()) }
            .map_err(|error| error.to_string())?;
        return Ok(
            json!({"dialogId":current.id,"status":"dispatched","completion":"query-native-result"}),
        );
    }
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|error| error.to_string())?;
    let _apartment = Apartment;
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| error.to_string())?;
    let result = unsafe {
        automation.cast::<IUIAutomation2>().and_then(|settings| {
            settings.SetConnectionTimeout(2000)?;
            settings.SetTransactionTimeout(2000)
        })
    };
    result.map_err(|error| error.to_string())?;
    let root = unsafe { automation.ElementFromHandle(hwnd) }.map_err(|error| error.to_string())?;
    let walker = unsafe { automation.ControlViewWalker() }.map_err(|error| error.to_string())?;
    let path = if name == "inspect" && args.get("nodePath").is_none() {
        vec![]
    } else {
        node_path(args)?
    };
    let element = unsafe { at(&walker, &root, &path) }?;
    if name != "inspect" {
        // Recheck the lifecycle after resolving the native node, before acting.
        if active(&json!({"dialogId":current.id}))?.is_none() || window(&current)? != hwnd {
            return Err("debug_native_dialog_not_open".into());
        }
        let result = unsafe {
            match name {
                "press" => {
                    if args["action"]
                        .as_str()
                        .is_some_and(|action| action != "Invoke")
                    {
                        return Err("debug_dialog_action_not_supported".into());
                    }
                    element
                        .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                        .and_then(|pattern| pattern.Invoke())
                }
                "selectRow" => element
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                        UIA_SelectionItemPatternId,
                    )
                    .and_then(|pattern| pattern.Select()),
                "setValue" => {
                    let value = args["value"]
                        .as_str()
                        .ok_or("debug_dialog_value_required")?;
                    element
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .and_then(|pattern| pattern.SetValue(&BSTR::from(value)))
                }
                _ => return Err("debug_dialog_action_not_supported".into()),
            }
        };
        result.map_err(|error| format!("debug_dialog_action_unconfirmed: {error}"))?;
        return Ok(
            json!({"dialogId":current.id,"nodePath":path,"status":"dispatched","completion":"query-native-result"}),
        );
    }
    let started = Instant::now();
    let mut pending = VecDeque::from([(element, path)]);
    let mut nodes = Vec::new();
    let mut failures = Vec::new();
    while nodes.len() < 512 && started.elapsed() < Duration::from_secs(4) {
        let Some((element, path)) = pending.pop_front() else {
            break;
        };
        let mut row = json!({"nodePath":path});
        let mut errors = Vec::new();
        macro_rules! attr { ($key:literal, $value:expr) => { match $value { Ok(value) => row[$key] = json!(value), Err(error) => errors.push(json!({"attribute":$key,"error":error.to_string()})) } }; }
        unsafe {
            attr!("name", element.CurrentName().map(|v| v.to_string()));
            attr!(
                "automationId",
                element.CurrentAutomationId().map(|v| v.to_string())
            );
            attr!("controlType", element.CurrentControlType().map(|v| v.0));
            attr!("enabled", element.CurrentIsEnabled().map(|v| v.as_bool()));
            attr!(
                "offscreen",
                element.CurrentIsOffscreen().map(|v| v.as_bool())
            );
            attr!(
                "bounds",
                element.CurrentBoundingRectangle().map(|v| [
                    v.left,
                    v.top,
                    v.right - v.left,
                    v.bottom - v.top
                ])
            );
            let mut actions = Vec::new();
            if element.GetCurrentPattern(UIA_InvokePatternId).is_ok() {
                actions.push("dialog.press");
            }
            if element
                .GetCurrentPattern(UIA_SelectionItemPatternId)
                .is_ok()
            {
                actions.push("dialog.selectRow");
            }
            if let Ok(value) =
                element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            {
                attr!("value", value.CurrentValue().map(|v| v.to_string()));
                attr!("readOnly", value.CurrentIsReadOnly().map(|v| v.as_bool()));
                if row["readOnly"] == false {
                    actions.push("dialog.setValue");
                }
            }
            row["actions"] = json!(actions);
            let children = (|| -> Result<(), String> {
                if path.len() >= 32 {
                    return Err("debug_dialog_depth_limit".into());
                }
                let mut child = optional(walker.GetFirstChildElement(&element))?;
                let mut index = 0;
                while let Some(item) = child {
                    if pending.len() + nodes.len() >= 512
                        || started.elapsed() >= Duration::from_secs(4)
                    {
                        return Err("debug_dialog_observation_budget".into());
                    }
                    child = optional(walker.GetNextSiblingElement(&item))?;
                    let mut next = path.clone();
                    next.push(index);
                    index += 1;
                    pending.push_back((item, next));
                }
                Ok(())
            })();
            if let Err(error) = children {
                failures.push(json!({"nodePath":path,"error":error}));
            }
        }
        row["attributeErrors"] = json!(errors);
        nodes.push(row);
    }
    let truncated = !pending.is_empty() || !failures.is_empty();
    Ok(
        json!({"id":current.id,"status":"waiting","kind":"native-path-dialog","platform":"windows","title":current.title,"panelWindowId":hwnd.0 as usize,"parentWindowId":current.parent,"actions":["dialog.inspect","dialog.press","dialog.setValue","dialog.selectRow","dialog.cancel"],"accessibility":{"nodes":nodes,"truncated":truncated,"coverage":if truncated {"partial"} else {"complete"},"failures":failures,"maxNodes":512}}),
    )
}

unsafe fn menu_command(name: &str, args: &Value, parent: HWND) -> Result<Value, String> {
    let root = GetMenu(parent);
    if root.is_invalid() {
        return Err("debug_native_menu_unavailable".into());
    }
    if name == "menu" {
        let path: Vec<usize> = serde_json::from_value(args["itemPath"].clone())
            .map_err(|_| "debug_menu_path_required")?;
        if path.is_empty() || path.len() > 8 {
            return Err("debug_menu_path_invalid".into());
        }
        let mut menu = root;
        for (depth, &index) in path.iter().enumerate() {
            let count = GetMenuItemCount(Some(menu));
            if count < 0 || index >= count as usize {
                return Err("debug_menu_item_missing".into());
            }
            let flags = GetMenuState(menu, index as u32, MF_BYPOSITION);
            if flags == u32::MAX {
                return Err(windows::core::Error::from_win32().to_string());
            }
            if flags & (MF_DISABLED.0 | MF_GRAYED.0 | MF_SEPARATOR.0) != 0 {
                return Err("debug_menu_item_disabled".into());
            }
            let submenu = GetSubMenu(menu, index as i32);
            if depth + 1 == path.len() {
                if !submenu.is_invalid() {
                    return Err("debug_menu_select_leaf_required".into());
                }
                let id = GetMenuItemID(menu, index as i32);
                if id == u32::MAX {
                    return Err("debug_menu_item_missing".into());
                }
                PostMessageW(
                    Some(parent),
                    WM_COMMAND,
                    windows::Win32::Foundation::WPARAM(id as usize),
                    LPARAM(0),
                )
                .map_err(|error| error.to_string())?;
            } else {
                if submenu.is_invalid() {
                    return Err("debug_menu_submenu_missing".into());
                }
                menu = submenu;
            }
        }
        return Ok(json!({"status":"dispatched","itemPath":path}));
    }
    let mut rows = Vec::new();
    let mut pending = vec![(root, Vec::<usize>::new())];
    while let Some((menu, path)) = pending.pop() {
        let count = GetMenuItemCount(Some(menu));
        if count < 0 {
            return Err(windows::core::Error::from_win32().to_string());
        }
        for index in 0..count {
            let mut item_path = path.clone();
            item_path.push(index as usize);
            let len = GetMenuStringW(menu, index as u32, None, MF_BYPOSITION);
            let mut title = vec![0u16; len as usize + 1];
            let copied = GetMenuStringW(menu, index as u32, Some(&mut title), MF_BYPOSITION);
            let flags = GetMenuState(menu, index as u32, MF_BYPOSITION);
            if flags == u32::MAX {
                return Err(windows::core::Error::from_win32().to_string());
            }
            let submenu = GetSubMenu(menu, index);
            rows.push(json!({"itemPath":item_path,"title":String::from_utf16_lossy(&title[..copied as usize]),"enabled":flags & (MF_DISABLED.0 | MF_GRAYED.0 | MF_SEPARATOR.0) == 0,"submenu":!submenu.is_invalid()}));
            if !submenu.is_invalid() && item_path.len() < 8 {
                pending.push((submenu, item_path));
            }
        }
    }
    Ok(json!({"items":rows}))
}

pub fn capture(path: &Path) -> Result<Option<Value>, String> {
    use windows::Win32::{
        Graphics::Gdi::*,
        Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS},
    };
    let Some((current, hwnd)) = observed_window(&json!({}))? else {
        return Ok(None);
    };
    unsafe {
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|error| error.to_string())?;
        let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
        if width <= 0 || height <= 0 || i64::from(width) * i64::from(height) > 16 * 1024 * 1024 {
            return Err("debug_dialog_capture_bounds_invalid".into());
        }
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            return Err(windows::core::Error::from_win32().to_string());
        }
        let result = (|| -> Result<Vec<u8>, String> {
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut pixels = std::ptr::null_mut();
            let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut pixels, None, 0)
                .map_err(|error| error.to_string())?;
            let previous = SelectObject(dc, bitmap.into());
            let printed = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(2));
            let result = if printed.as_bool() {
                let mut bytes =
                    std::slice::from_raw_parts(pixels as *const u8, (width * height * 4) as usize)
                        .to_vec();
                for pixel in bytes.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                    pixel[3] = 255;
                }
                Ok(bytes)
            } else {
                Err(windows::core::Error::from_win32().to_string())
            };
            SelectObject(dc, previous);
            let _ = DeleteObject(bitmap.into());
            result
        })();
        let _ = DeleteDC(dc);
        let bytes = result?;
        if active(&json!({"dialogId":current.id}))?.is_none() {
            return Err("debug_native_dialog_closed_during_capture".into());
        }
        let image = image::RgbaImage::from_raw(width as u32, height as u32, bytes)
            .ok_or("debug_dialog_capture_invalid")?;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .map_err(|error| error.to_string())?;
        image
            .write_to(&mut file, image::ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        Ok(Some(
            json!({"contentRef":path,"contentType":"image/png","width":width,"height":height,"range":"native-dialog","dialogId":current.id,"windowId":hwnd.0 as usize}),
        ))
    }
}
