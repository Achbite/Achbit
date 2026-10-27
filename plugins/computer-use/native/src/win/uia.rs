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
// UIAutomation rejects timeout values below 50 ms. Stop when the remaining
// budget cannot fund a supported call, instead of extending that budget.
const PROVIDER_MIN_TIMEOUT_MS: u32 = 50;

pub struct Automation {
    automation: IUIAutomation,
    timeouts: Option<IUIAutomation2>,
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
            let timeouts = automation.cast::<IUIAutomation2>().ok();
            if let Some(timeouts) = &timeouts {
                timeouts
                    .SetConnectionTimeout(PROVIDER_TIMEOUT_MS)
                    .map_err(message)?;
                timeouts
                    .SetTransactionTimeout(PROVIDER_TIMEOUT_MS)
                    .map_err(message)?;
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
                timeouts,
                walker,
                cache,
            })
        }
    }

    fn prepare_read(&self, deadline: Instant) -> Result<(), String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| *remaining >= Duration::from_millis(PROVIDER_MIN_TIMEOUT_MS.into()))
            .ok_or("UI Automation observation time budget reached; tree is incomplete")?;
        // Bound each cross-process call by the remaining traversal budget.
        let millis = remaining.as_millis().min(PROVIDER_TIMEOUT_MS as u128) as u32;
        self.set_timeouts(millis)
    }

    fn set_timeouts(&self, millis: u32) -> Result<(), String> {
        if let Some(timeouts) = &self.timeouts {
            unsafe {
                timeouts
                    .SetConnectionTimeout(millis)
                    .map_err(|error| format!("ConnectionTimeout({millis}): {}", message(error)))?;
                timeouts
                    .SetTransactionTimeout(millis)
                    .map_err(|error| format!("TransactionTimeout({millis}): {}", message(error)))?;
            }
        }
        Ok(())
    }

    fn next(
        &self,
        element: &IUIAutomationElement,
        child: bool,
        deadline: Instant,
    ) -> Result<Option<IUIAutomationElement>, String> {
        self.prepare_read(deadline)?;
        optional(unsafe {
            if child {
                self.walker
                    .GetFirstChildElementBuildCache(element, &self.cache)
            } else {
                self.walker
                    .GetNextSiblingElementBuildCache(element, &self.cache)
            }
        })
    }

    /// Pre-order control-view tree of exactly this window. Read errors and budget
    /// truncation are preserved as incomplete evidence.
    pub fn tree(&self, window: &Window) -> Result<Tree, String> {
        self.tree_with_budget(window, TREE_TIME_BUDGET, TREE_ELEMENT_BUDGET)
    }

    fn tree_with_budget(
        &self,
        window: &Window,
        time: Duration,
        limit: usize,
    ) -> Result<Tree, String> {
        let result = self.read_tree(window, time, limit);
        // A nearly exhausted read budget must not shorten the next semantic action.
        let restored = self.set_timeouts(PROVIDER_TIMEOUT_MS);
        match (result, restored) {
            (Ok(mut tree), Err(message)) => {
                tree.accessibility["complete"] = json!(false);
                tree.accessibility["errors"]
                    .as_array_mut()
                    .expect("tree errors")
                    .push(json!({"phase":"accessibilityTimeoutRestore","message":message}));
                Ok(tree)
            }
            (Err(error), Err(restored)) => {
                Err(format!("{error}; restoring UIA timeout: {restored}"))
            }
            (result, Ok(())) => result,
        }
    }

    fn read_tree(&self, window: &Window, time: Duration, limit: usize) -> Result<Tree, String> {
        let deadline = Instant::now() + time;
        if let Some(error) = budget_error(deadline, 0, limit) {
            return Ok(Tree {
                items: Vec::new(),
                handles: Vec::new(),
                accessibility: json!({"complete":false,"errors":[error]}),
            });
        }
        self.prepare_read(deadline)?;
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
        // Retain only ancestors. Reading all siblings first bypasses both budgets
        // and discards earlier children when a later sibling read fails.
        let mut parents: Vec<(IUIAutomationElement, usize)> = Vec::new();
        let mut current = Some(root);
        let (mut items, mut handles, mut errors) = (Vec::new(), Vec::new(), Vec::new());
        'walk: while let Some(mut element) = current.take() {
            if let Some(error) = budget_error(deadline, items.len(), limit) {
                errors.push(error);
                break;
            }
            let mut index = handles.len();
            let item = describe(&element, parents.len(), index, &mut errors);
            items.push(item);
            handles.push(element.clone());
            if let Some(error) = budget_error(deadline, items.len(), limit) {
                errors.push(error);
                break;
            }
            match self.next(&element, true, deadline) {
                Ok(Some(child)) => {
                    parents.push((element, index));
                    current = Some(child);
                    continue;
                }
                Ok(None) => {}
                Err(message) => errors.push(json!({"depth":parents.len(),
                    "elementId":format!("element:{index}"),"attribute":"children","message":message})),
            }
            // A root sibling is outside the observed window. Walk back through
            // retained ancestors without rereading a possibly changed parent.
            while !parents.is_empty() {
                if let Some(error) = budget_error(deadline, items.len(), limit) {
                    errors.push(error);
                    break 'walk;
                }
                match self.next(&element, false, deadline) {
                    Ok(Some(sibling)) => {
                        current = Some(sibling);
                        break;
                    }
                    Ok(None) => {}
                    Err(message) => errors.push(json!({"depth":parents.len(),
                        "elementId":format!("element:{index}"),"attribute":"nextSibling","message":message})),
                }
                (element, index) = parents.pop().expect("retained ancestor");
            }
            if current.is_none() && Instant::now() >= deadline {
                if let Some(error) = budget_error(deadline, items.len(), limit) {
                    errors.push(error);
                }
            }
        }
        Ok(Tree {
            items,
            accessibility: json!({"complete":errors.is_empty(),"errors":errors}),
            handles,
        })
    }
}

fn budget_error(deadline: Instant, count: usize, limit: usize) -> Option<Value> {
    let reason = if deadline.saturating_duration_since(Instant::now())
        < Duration::from_millis(PROVIDER_MIN_TIMEOUT_MS.into())
    {
        "time"
    } else if count >= limit {
        "element"
    } else {
        return None;
    };
    Some(json!({"phase":"accessibilityTree","message":format!(
        "UI Automation observation {reason} budget reached ({count} elements); tree is incomplete")}))
}

struct ElementRead<'a> {
    depth: usize,
    index: usize,
    errors: &'a mut Vec<Value>,
}

impl ElementRead<'_> {
    fn get<T>(&mut self, result: windows::core::Result<T>, attribute: &str) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            // A null COM result with a success HRESULT, or explicit unsupported
            // property/pattern, is absence. Other errors must remain observable.
            Err(error) if error.code().is_ok() || error.code().0 as u32 == UIA_E_NOTSUPPORTED => {
                None
            }
            Err(error) => {
                self.errors.push(
                    json!({"depth":self.depth,"elementId":format!("element:{}",self.index),
                    "attribute":attribute,"message":message(error)}),
                );
                None
            }
        }
    }
}

fn text(value: BSTR) -> Option<String> {
    let value = value.to_string();
    (!value.is_empty()).then_some(value)
}

fn describe(
    element: &IUIAutomationElement,
    depth: usize,
    index: usize,
    errors: &mut Vec<Value>,
) -> Item {
    let mut value = json!({"depth":depth,"elementId":format!("element:{index}")});
    let mut bounds = None;
    let mut read = ElementRead {
        depth,
        index,
        errors,
    };
    unsafe {
        if let Some(kind) = read.get(element.CachedControlType(), "ControlType") {
            value["role"] = json!(control_type(kind));
        }
        if let Some(name) = read.get(element.CachedName(), "Name").and_then(text) {
            value["title"] = json!(name);
        }
        if let Some(help) = read
            .get(element.CachedHelpText(), "HelpText")
            .and_then(text)
        {
            value["description"] = json!(help);
        }
        if let Some(id) = read
            .get(element.CachedAutomationId(), "AutomationId")
            .and_then(text)
        {
            value["automationId"] = json!(id);
        }
        if read
            .get(element.CachedIsEnabled(), "IsEnabled")
            .is_some_and(|enabled| !enabled.as_bool())
        {
            value["enabled"] = json!(false);
        }
        if read
            .get(element.CachedIsOffscreen(), "IsOffscreen")
            .is_some_and(|offscreen| offscreen.as_bool())
        {
            value["offscreen"] = json!(true);
        }
        if let Some(rect) = read.get(element.CachedBoundingRectangle(), "BoundingRectangle") {
            bounds = desktop::rect_bounds(rect);
        }
        let mut actions = Vec::new();
        if read
            .get(
                element.GetCachedPattern(UIA_InvokePatternId),
                "InvokePattern",
            )
            .is_some()
        {
            actions.push("invoke");
        }
        if let Some(toggle) = read.get(
            element.GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId),
            "TogglePattern",
        ) {
            actions.push("toggle");
            if let Some(state) = read.get(toggle.CachedToggleState(), "ToggleState") {
                value["value"] = json!(if state == ToggleState_On {
                    "on"
                } else if state == ToggleState_Off {
                    "off"
                } else {
                    "indeterminate"
                });
            }
        }
        if read
            .get(
                element.GetCachedPattern(UIA_SelectionItemPatternId),
                "SelectionItemPattern",
            )
            .is_some()
        {
            actions.push("select");
        }
        if let Some(expand) = read.get(
            element.GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(
                UIA_ExpandCollapsePatternId,
            ),
            "ExpandCollapsePattern",
        ) {
            if let Some(state) = read.get(expand.CachedExpandCollapseState(), "ExpandCollapseState")
            {
                if state != ExpandCollapseState_LeafNode {
                    actions.push(if state == ExpandCollapseState_Expanded {
                        "collapse"
                    } else {
                        "expand"
                    });
                }
            }
        }
        if let Some(pattern) = read.get(
            element.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId),
            "ValuePattern",
        ) {
            if let Some(current) = read.get(pattern.CachedValue(), "Value").and_then(text) {
                value["value"] = json!(current);
            }
            if let Some(read_only) = read.get(pattern.CachedIsReadOnly(), "ValueIsReadOnly") {
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
            if text(pattern.CurrentDefaultAction().map_err(unconfirmed)?).is_some() {
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

    #[test]
    fn cached_read_errors_retain_hresult_and_element_attribute() {
        let mut errors = Vec::new();
        let mut read = ElementRead {
            depth: 2,
            index: 7,
            errors: &mut errors,
        };
        for code in [
            windows::core::HRESULT(UIA_E_ELEMENTNOTAVAILABLE as i32),
            windows::core::HRESULT(0x8000_4005_u32 as i32),
        ] {
            assert!(read
                .get::<BSTR>(
                    Err(windows::core::Error::new(code, "provider read failed")),
                    "Name"
                )
                .is_none());
        }
        assert_eq!(errors.len(), 2);
        for error in &errors {
            assert_eq!(error["elementId"], "element:7");
            assert_eq!(error["attribute"], "Name");
            assert_eq!(error["depth"], 2);
            assert!(error["message"]
                .as_str()
                .unwrap()
                .contains("provider read failed"));
        }
        assert!(errors[0]["message"]
            .as_str()
            .unwrap()
            .contains("0x80040201"));
        assert!(errors[1]["message"]
            .as_str()
            .unwrap()
            .contains("0x80004005"));
    }

    #[test]
    fn unsupported_patterns_and_empty_values_are_not_read_failures() {
        let mut errors = Vec::new();
        let mut read = ElementRead {
            depth: 0,
            index: 0,
            errors: &mut errors,
        };
        assert!(read
            .get::<u8>(Err(windows::core::Error::empty()), "InvokePattern")
            .is_none());
        assert!(read
            .get::<u8>(
                Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    UIA_E_NOTSUPPORTED as i32
                ))),
                "ValuePattern"
            )
            .is_none());
        assert_eq!(read.get(Ok(BSTR::from("")), "Name").and_then(text), None);
        assert!(errors.is_empty());
    }

    #[test]
    #[ignore = "requires an interactive Windows desktop and UI Automation"]
    fn native_tree_preserves_order_and_reports_count_and_time_truncation() {
        super::super::tests::initialize();
        let fixture = super::super::tests::Fixture::open(64);
        let automation = Automation::new().unwrap();
        let window = desktop::snapshot(fixture.target).unwrap();
        let complete = automation.tree(&window).unwrap();
        assert_eq!(
            complete.accessibility["complete"], true,
            "{}",
            complete.accessibility
        );
        assert!(complete
            .items
            .iter()
            .any(|item| item.value["title"] == "Child 63"));
        let bounded = automation
            .tree_with_budget(&window, TREE_TIME_BUDGET, 16)
            .unwrap();
        assert_eq!(bounded.items.len(), 16);
        assert_eq!(bounded.handles.len(), 16);
        assert_eq!(bounded.accessibility["complete"], false);
        assert!(bounded.accessibility["errors"][0]["message"]
            .as_str()
            .unwrap()
            .contains("element budget"));
        for (index, item) in bounded.items.iter().enumerate() {
            assert_eq!(item.value, complete.items[index].value);
        }
        let timed = automation
            .tree_with_budget(&window, Duration::from_millis(1), TREE_ELEMENT_BUDGET)
            .unwrap();
        assert_eq!(timed.accessibility["complete"], false);
        assert!(timed.accessibility["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|error| error["message"].as_str().unwrap().contains("time budget")));
        assert_eq!(
            automation.tree(&window).unwrap().accessibility["complete"],
            true,
            "a truncated read must not poison subsequent UIA calls"
        );
    }
}
