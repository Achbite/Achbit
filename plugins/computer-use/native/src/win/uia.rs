//! UI Automation tree reads and semantic actions. Element handles stay in this
//! process; the model only receives indexes bound to one observation.
use super::desktop::{self, Window};
use crate::protocol::Bounds;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use windows::core::{Interface, BSTR};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Accessibility::*;

/// Bounds model context and unresponsive providers; truncation is reported.
const TREE_TIME_BUDGET: Duration = Duration::from_secs(4);
const TREE_ELEMENT_BUDGET: usize = 4000;
/// Cross-process UIA calls to a hung app fail after this many milliseconds.
const PROVIDER_TIMEOUT_MS: u32 = 2000;

pub struct Automation {
    automation: IUIAutomation,
    walker: IUIAutomationTreeWalker,
    cache: IUIAutomationCacheRequest,
}

pub struct Item {
    pub value: Value,
    /// Desktop pixels; mapped to screenshot pixels by the caller.
    pub bounds: Option<Bounds>,
}

pub struct Tree {
    pub items: Vec<Item>,
    pub accessibility: Value,
    pub handles: Vec<IUIAutomationElement>,
}

fn message(error: windows::core::Error) -> String {
    format!(
        "UI Automation error {:#010x}: {}",
        error.code().0,
        error.message()
    )
}

/// A successful call that produced no element means "absent", not a failure.
fn optional<T>(result: windows::core::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code().is_ok() => Ok(None),
        Err(error) => Err(message(error)),
    }
}

impl Automation {
    pub fn new() -> Result<Self, String> {
        unsafe {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                    .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
                    .map_err(|error| format!("UI Automation is unavailable: {}", message(error)))?;
            if let Ok(timeouts) = automation.cast::<IUIAutomation2>() {
                let _ = timeouts.SetConnectionTimeout(PROVIDER_TIMEOUT_MS);
                let _ = timeouts.SetTransactionTimeout(PROVIDER_TIMEOUT_MS);
            }
            let walker = automation.ControlViewWalker().map_err(message)?;
            let cache = automation.CreateCacheRequest().map_err(message)?;
            for property in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_HelpTextPropertyId,
                UIA_AutomationIdPropertyId,
                UIA_IsEnabledPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_ValueValuePropertyId,
                UIA_ValueIsReadOnlyPropertyId,
                UIA_ToggleToggleStatePropertyId,
                UIA_ExpandCollapseExpandCollapseStatePropertyId,
            ] {
                cache.AddProperty(property).map_err(message)?;
            }
            for pattern in [
                UIA_InvokePatternId,
                UIA_ValuePatternId,
                UIA_TogglePatternId,
                UIA_SelectionItemPatternId,
                UIA_ExpandCollapsePatternId,
            ] {
                cache.AddPattern(pattern).map_err(message)?;
            }
            Ok(Self {
                automation,
                walker,
                cache,
            })
        }
    }

    fn children(
        &self,
        element: &IUIAutomationElement,
    ) -> Result<Vec<IUIAutomationElement>, String> {
        let mut children = Vec::new();
        let mut next = optional(unsafe {
            self.walker
                .GetFirstChildElementBuildCache(element, &self.cache)
        })?;
        while let Some(child) = next {
            next = optional(unsafe {
                self.walker
                    .GetNextSiblingElementBuildCache(&child, &self.cache)
            })?;
            children.push(child);
        }
        Ok(children)
    }

    /// Pre-order control-view tree of exactly this window. Read errors and budget
    /// truncation are preserved as incomplete evidence.
    pub fn tree(&self, window: &Window) -> Result<Tree, String> {
        let root = unsafe {
            self.automation
                .ElementFromHandleBuildCache(window.hwnd(), &self.cache)
        }
        .map_err(|error| {
            format!(
                "Cannot read the window's UI Automation tree: {}",
                message(error)
            )
        })?;
        let started = Instant::now();
        let mut stack = vec![(root, 0usize)];
        let (mut items, mut handles, mut errors) = (Vec::new(), Vec::new(), Vec::new());
        while let Some((element, depth)) = stack.pop() {
            if started.elapsed() > TREE_TIME_BUDGET || items.len() >= TREE_ELEMENT_BUDGET {
                errors.push(json!({"phase":"accessibilityTree","message":format!(
                    "UI Automation observation budget reached ({} elements); tree is incomplete", items.len())}));
                break;
            }
            let mut item = describe(&element, depth);
            item.value["elementId"] = json!(format!("element:{}", handles.len()));
            match self.children(&element) {
                Ok(children) => {
                    stack.extend(children.into_iter().rev().map(|child| (child, depth + 1)))
                }
                Err(message) => errors.push(json!({"depth":depth,"message":message})),
            }
            items.push(item);
            handles.push(element);
        }
        Ok(Tree {
            items,
            accessibility: json!({"complete":errors.is_empty(),"errors":errors}),
            handles,
        })
    }
}

fn text(value: windows::core::Result<BSTR>) -> Option<String> {
    value
        .ok()
        .map(|text| text.to_string())
        .filter(|text| !text.is_empty())
}

fn describe(element: &IUIAutomationElement, depth: usize) -> Item {
    let mut value = json!({"depth":depth});
    let mut bounds = None;
    unsafe {
        if let Ok(kind) = element.CachedControlType() {
            value["role"] = json!(control_type(kind));
        }
        if let Some(name) = text(element.CachedName()) {
            value["title"] = json!(name);
        }
        if let Some(help) = text(element.CachedHelpText()) {
            value["description"] = json!(help);
        }
        if let Some(id) = text(element.CachedAutomationId()) {
            value["automationId"] = json!(id);
        }
        if element
            .CachedIsEnabled()
            .is_ok_and(|enabled| !enabled.as_bool())
        {
            value["enabled"] = json!(false);
        }
        if element
            .CachedIsOffscreen()
            .is_ok_and(|offscreen| offscreen.as_bool())
        {
            value["offscreen"] = json!(true);
        }
        if let Ok(rect) = element.CachedBoundingRectangle() {
            bounds = desktop::rect_bounds(rect);
        }
        let mut actions = Vec::new();
        if element.GetCachedPattern(UIA_InvokePatternId).is_ok() {
            actions.push("invoke");
        }
        if let Ok(toggle) =
            element.GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        {
            actions.push("toggle");
            if let Ok(state) = toggle.CachedToggleState() {
                value["value"] = json!(if state == ToggleState_On {
                    "on"
                } else if state == ToggleState_Off {
                    "off"
                } else {
                    "indeterminate"
                });
            }
        }
        if element.GetCachedPattern(UIA_SelectionItemPatternId).is_ok() {
            actions.push("select");
        }
        if let Ok(expand) = element
            .GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
        {
            if let Ok(state) = expand.CachedExpandCollapseState() {
                if state != ExpandCollapseState_LeafNode {
                    actions.push(if state == ExpandCollapseState_Expanded {
                        "collapse"
                    } else {
                        "expand"
                    });
                }
            }
        }
        if let Ok(pattern) =
            element.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        {
            if let Some(current) = text(pattern.CachedValue()) {
                value["value"] = json!(current);
            }
            if let Ok(read_only) = pattern.CachedIsReadOnly() {
                value["valueSettable"] = json!(!read_only.as_bool());
            }
        }
        if !actions.is_empty() {
            value["actions"] = json!(actions);
        }
    }
    Item { value, bounds }
}

fn unconfirmed(error: windows::core::Error) -> String {
    format!(
        "{}; effect is not confirmed. Observe before deciding any further action; no mouse or keyboard fallback was attempted.",
        message(error)
    )
}

fn element<'a>(
    elements: &'a [IUIAutomationElement],
    input: &Value,
) -> Result<&'a IUIAutomationElement, String> {
    let index = input["elementId"]
        .as_str()
        .and_then(|id| id.strip_prefix("element:"))
        .and_then(|index| index.parse::<usize>().ok())
        .ok_or("Invalid elementId")?;
    elements
        .get(index)
        .ok_or_else(|| "Unknown elementId; observe again".into())
}

/// Current desktop centre of the selected element, for target-relative feedback.
pub fn element_center(elements: &[IUIAutomationElement], input: &Value) -> Option<(f64, f64)> {
    let rect = unsafe { element(elements, input).ok()?.CurrentBoundingRectangle() }.ok()?;
    let bounds = desktop::rect_bounds(rect)?;
    Some((
        bounds.x + bounds.width / 2.0,
        bounds.y + bounds.height / 2.0,
    ))
}

/// press uses the element's semantic action; setValue replaces its value.
/// Neither moves the cursor or injects global input.
pub fn perform(
    elements: &[IUIAutomationElement],
    input: &Value,
    action: &str,
) -> Result<Option<IUIAutomationValuePattern>, String> {
    let element = element(elements, input)?;
    unsafe {
        if action == "setValue" {
            let text = input["text"].as_str().ok_or("Missing text")?;
            let pattern = element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .map_err(|_| "Element does not support the UI Automation Value pattern; setValue was not attempted")?;
            pattern.SetValue(&BSTR::from(text)).map_err(unconfirmed)?;
            return Ok(Some(pattern));
        }
        if let Ok(pattern) =
            element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
        {
            return pattern.Invoke().map(|()| None).map_err(unconfirmed);
        }
        if let Ok(pattern) =
            element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        {
            return pattern.Toggle().map(|()| None).map_err(unconfirmed);
        }
        if let Ok(pattern) = element
            .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
        {
            return pattern.Select().map(|()| None).map_err(unconfirmed);
        }
        if let Ok(pattern) = element
            .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
        {
            let state = pattern.CurrentExpandCollapseState().map_err(unconfirmed)?;
            let result = if state == ExpandCollapseState_Expanded {
                pattern.Collapse()
            } else {
                pattern.Expand()
            };
            return result.map(|()| None).map_err(unconfirmed);
        }
        if let Ok(pattern) = element.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
            UIA_LegacyIAccessiblePatternId,
        ) {
            if text(pattern.CurrentDefaultAction()).is_some() {
                return pattern
                    .DoDefaultAction()
                    .map(|()| None)
                    .map_err(unconfirmed);
            }
        }
    }
    Err("Element exposes no UI Automation press action (Invoke, Toggle, SelectionItem, ExpandCollapse or default action); no mouse or keyboard fallback was attempted.".into())
}

pub fn verify_value(pattern: &IUIAutomationValuePattern, expected: &str) -> Result<Value, String> {
    crate::value_verification::verify(expected, || {
        unsafe { pattern.CurrentValue() }
            .map(|value| json!(value.to_string()))
            .map_err(message)
    })
}

/// UIA control type IDs are the contiguous range starting at UIA_ButtonControlTypeId.
const CONTROL_TYPES: [&str; 41] = [
    "Button",
    "Calendar",
    "CheckBox",
    "ComboBox",
    "Edit",
    "Hyperlink",
    "Image",
    "ListItem",
    "List",
    "Menu",
    "MenuBar",
    "MenuItem",
    "ProgressBar",
    "RadioButton",
    "ScrollBar",
    "Slider",
    "Spinner",
    "StatusBar",
    "Tab",
    "TabItem",
    "Text",
    "ToolBar",
    "ToolTip",
    "Tree",
    "TreeItem",
    "Custom",
    "Group",
    "Thumb",
    "DataGrid",
    "DataItem",
    "Document",
    "SplitButton",
    "Window",
    "Pane",
    "Header",
    "HeaderItem",
    "Table",
    "TitleBar",
    "Separator",
    "SemanticZoom",
    "AppBar",
];

fn control_type(kind: UIA_CONTROLTYPE_ID) -> String {
    usize::try_from(kind.0 - UIA_ButtonControlTypeId.0)
        .ok()
        .and_then(|index| CONTROL_TYPES.get(index))
        .map(|name| (*name).to_string())
        .unwrap_or_else(|| format!("ControlType({})", kind.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_type_names_follow_the_uia_id_range() {
        for (kind, name) in [
            (UIA_ButtonControlTypeId, "Button"),
            (UIA_EditControlTypeId, "Edit"),
            (UIA_WindowControlTypeId, "Window"),
            (UIA_PaneControlTypeId, "Pane"),
            (UIA_AppBarControlTypeId, "AppBar"),
        ] {
            assert_eq!(control_type(kind), name);
        }
        assert_eq!(
            control_type(UIA_CONTROLTYPE_ID(49999)),
            "ControlType(49999)"
        );
    }

    #[test]
    fn absent_uia_results_are_not_errors() {
        assert_eq!(
            optional::<u8>(Err(windows::core::Error::empty())).unwrap(),
            None
        );
        assert!(optional::<u8>(Err(windows::core::Error::from_hresult(
            windows::core::HRESULT(0x8000_4005_u32 as i32)
        )))
        .is_err());
    }
}
