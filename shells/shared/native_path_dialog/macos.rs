use super::PathOptions;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSModalResponseCancel, NSModalResponseOK, NSOpenPanel};
use objc2_foundation::{NSArray, NSString, NSURL};
use std::path::PathBuf;

fn configured_panel(
    parent: &tauri::Window,
    options: &PathOptions,
) -> Result<objc2::rc::Retained<NSOpenPanel>, String> {
    let main = MainThreadMarker::new().ok_or("native_dialog_requires_main_thread")?;
    parent.set_focus().map_err(|error| error.to_string())?;
    // NSOpenPanel natively supports files and directories in the same view.
    let panel = NSOpenPanel::openPanel(main);
    panel.setTitle(Some(&NSString::from_str(&options.title)));
    panel.setPrompt(Some(&NSString::from_str(&options.select_label)));
    panel.setCanChooseFiles(options.kind.as_deref() != Some("directory"));
    panel.setCanChooseDirectories(options.kind.as_deref() != Some("file"));
    panel.setAllowsMultipleSelection(options.multiple);
    panel.setCanCreateDirectories(false);
    if let Some(path) = &options.default_path {
        panel.setDirectoryURL(Some(&NSURL::fileURLWithPath(&NSString::from_str(path))));
    }
    if !options.filters.is_empty() {
        let extensions: Vec<_> = options
            .filters
            .iter()
            .flat_map(|filter| &filter.extensions)
            .map(|extension| NSString::from_str(extension))
            .collect();
        #[allow(deprecated)]
        panel.setAllowedFileTypes(Some(&NSArray::from_retained_slice(&extensions)));
    }
    Ok(panel)
}

fn selection(panel: &NSOpenPanel, response: isize) -> Result<Option<Vec<PathBuf>>, String> {
    match response {
        response if response == NSModalResponseCancel => Ok(None),
        response if response == NSModalResponseOK => panel
            .URLs()
            .iter()
            .map(|url| {
                url.path()
                    .map(|path| PathBuf::from(path.to_string()))
                    .ok_or_else(|| "native_dialog_selected_path_missing".to_string())
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        response => Err(format!("native_dialog_unexpected_response:{response}")),
    }
}

#[cfg(not(feature = "debug-control"))]
pub(super) fn pick(
    parent: &tauri::Window,
    options: &PathOptions,
) -> Result<Option<Vec<PathBuf>>, String> {
    let panel = configured_panel(parent, options)?;
    selection(&panel, panel.runModal())
}

#[cfg(feature = "debug-control")]
pub(super) fn begin(
    parent: &tauri::Window,
    options: &PathOptions,
    sender: std::sync::mpsc::SyncSender<Result<Option<Vec<PathBuf>>, String>>,
) -> Result<(), String> {
    let window = parent.ns_window().map_err(|error| error.to_string())?;
    let panel = configured_panel(parent, options)?;
    let id = debug_panel::opened(&panel)?;
    let result_panel = panel.clone();
    let completion = block2::RcBlock::new(move |response: isize| {
        let result = selection(&result_panel, response);
        debug_panel::completed(id.clone(), &result);
        let _ = sender.send(result);
    });
    unsafe {
        panel.beginSheetModalForWindow_completionHandler(
            &*(window as *const objc2_app_kit::NSWindow),
            &completion,
        );
    }
    Ok(())
}

#[cfg(feature = "debug-control")]
#[path = "debug_macos.rs"]
mod debug_panel;
#[cfg(feature = "debug-control")]
pub use debug_panel::capture as debug_capture;
#[cfg(feature = "debug-control")]
pub use debug_panel::command as debug_command;

#[cfg(feature = "debug-control")]
pub use debug_panel::accessibility_command as debug_accessibility_command;
