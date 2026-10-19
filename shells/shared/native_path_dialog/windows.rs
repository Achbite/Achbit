use super::PathOptions;
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use windows::core::{implement, Interface, Ref, BOOL, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_CANCELLED, S_OK};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    Common::COMDLG_FILTERSPEC, FileOpenDialog, IFileDialog, IFileDialogControlEvents,
    IFileDialogControlEvents_Impl, IFileDialogCustomize, IFileDialogEvents, IFileDialogEvents_Impl,
    IFileOpenDialog, IShellItem, IShellItemArray, SHCreateItemFromParsingName, CDCS_ENABLED,
    CDCS_VISIBLE, FDEOR_DEFAULT, FDESVR_DEFAULT, FDE_OVERWRITE_RESPONSE,
    FDE_SHAREVIOLATION_RESPONSE, FOS_ALLOWMULTISELECT, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST,
    SIGDN_FILESYSPATH,
};

const SELECT_ITEM: u32 = 1;
type Selection = Rc<RefCell<Option<windows::core::Result<Vec<PathBuf>>>>>;

struct ComApartment;
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn item_path(item: &IShellItem) -> windows::core::Result<PathBuf> {
    unsafe {
        let path = item.GetDisplayName(SIGDN_FILESYSPATH)?;
        let value = path.to_string();
        CoTaskMemFree(Some(path.0.cast()));
        Ok(PathBuf::from(value?))
    }
}

fn item_paths(items: &IShellItemArray) -> windows::core::Result<Vec<PathBuf>> {
    unsafe {
        (0..items.GetCount()?)
            .map(|index| item_path(&items.GetItemAt(index)?))
            .collect()
    }
}

// Windows' Open action navigates into folders. A native customization button
// confirms the highlighted item of either kind, without a separate picker mode.
#[implement(IFileDialogEvents, IFileDialogControlEvents)]
struct SelectionEvents {
    selection: Selection,
}

impl IFileDialogEvents_Impl for SelectionEvents_Impl {
    fn OnFileOk(&self, _: Ref<'_, IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnFolderChanging(
        &self,
        _: Ref<'_, IFileDialog>,
        _: Ref<'_, IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnFolderChange(&self, dialog: Ref<'_, IFileDialog>) -> windows::core::Result<()> {
        self.OnSelectionChange(dialog)
    }
    fn OnSelectionChange(&self, dialog: Ref<'_, IFileDialog>) -> windows::core::Result<()> {
        if let Some(dialog) = dialog.as_ref() {
            unsafe {
                let has_path = dialog
                    .GetCurrentSelection()
                    .and_then(|item| item_path(&item))
                    .is_ok();
                dialog.cast::<IFileDialogCustomize>()?.SetControlState(
                    SELECT_ITEM,
                    if has_path {
                        CDCS_VISIBLE | CDCS_ENABLED
                    } else {
                        CDCS_VISIBLE
                    },
                )?;
            }
        }
        Ok(())
    }
    fn OnShareViolation(
        &self,
        _: Ref<'_, IFileDialog>,
        _: Ref<'_, IShellItem>,
    ) -> windows::core::Result<FDE_SHAREVIOLATION_RESPONSE> {
        Ok(FDESVR_DEFAULT)
    }
    fn OnTypeChange(&self, _: Ref<'_, IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnOverwrite(
        &self,
        _: Ref<'_, IFileDialog>,
        _: Ref<'_, IShellItem>,
    ) -> windows::core::Result<FDE_OVERWRITE_RESPONSE> {
        Ok(FDEOR_DEFAULT)
    }
}

impl IFileDialogControlEvents_Impl for SelectionEvents_Impl {
    fn OnButtonClicked(
        &self,
        customize: Ref<'_, IFileDialogCustomize>,
        id: u32,
    ) -> windows::core::Result<()> {
        if id != SELECT_ITEM {
            return Ok(());
        }
        if let Some(customize) = customize.as_ref() {
            let dialog: IFileOpenDialog = customize.cast()?;
            unsafe {
                let result = (|| {
                    let items = dialog.GetSelectedItems()?;
                    item_paths(&items)
                })();
                *self.selection.borrow_mut() = Some(result);
                // Close does not publish GetResult; keep the actual selection above.
                dialog.Close(S_OK)?;
            }
        }
        Ok(())
    }
    fn OnItemSelected(
        &self,
        _: Ref<'_, IFileDialogCustomize>,
        _: u32,
        _: u32,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnCheckButtonToggled(
        &self,
        _: Ref<'_, IFileDialogCustomize>,
        _: u32,
        _: BOOL,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnControlActivating(
        &self,
        _: Ref<'_, IFileDialogCustomize>,
        _: u32,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}

#[cfg(not(feature = "debug-control"))]
pub(super) fn pick(
    parent: &tauri::Window,
    options: &PathOptions,
) -> Result<Option<Vec<PathBuf>>, String> {
    let hwnd = parent.hwnd().map_err(|error| error.to_string())?;
    pick_window(hwnd, options)
}

#[cfg(feature = "debug-control")]
pub(super) fn begin(
    parent: &tauri::Window,
    options: PathOptions,
    reply: std::sync::mpsc::SyncSender<Result<Option<Vec<PathBuf>>, String>>,
) -> Result<(), String> {
    let hwnd = parent.hwnd().map_err(|error| error.to_string())?.0 as isize;
    // Show owns a modal STA loop. Keep the GUI event loop available for Debug
    // inspection; only this worker owns and releases its COM dialog objects.
    std::thread::Builder::new()
        .name("debug-path-dialog".into())
        .spawn(move || {
            let result = pick_window(windows::Win32::Foundation::HWND(hwnd as *mut _), &options);
            let _ = reply.send(result);
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn pick_window(
    hwnd: windows::Win32::Foundation::HWND,
    options: &PathOptions,
) -> Result<Option<Vec<PathBuf>>, String> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| error.to_string())?;
    let _apartment = ComApartment;
    #[cfg(feature = "debug-control")]
    let dialog_id = super::debug_windows::opened(hwnd, &options.title)?;
    let run = || -> windows::core::Result<Option<Vec<PathBuf>>> {
        unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            dialog.SetOptions(dialog.GetOptions()? | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)?;
            if options.multiple {
                dialog.SetOptions(dialog.GetOptions()? | FOS_ALLOWMULTISELECT)?;
            }
            dialog.SetTitle(&HSTRING::from(&options.title))?;
            if let Some(path) = &options.default_path {
                let folder: IShellItem = SHCreateItemFromParsingName(&HSTRING::from(path), None)?;
                dialog.SetFolder(&folder)?;
            }
            let filters: Vec<_> = options
                .filters
                .iter()
                .map(|filter| {
                    (
                        HSTRING::from(&filter.name),
                        HSTRING::from(
                            filter
                                .extensions
                                .iter()
                                .map(|ext| format!("*.{ext}"))
                                .collect::<Vec<_>>()
                                .join(";"),
                        ),
                    )
                })
                .collect();
            let filter_specs: Vec<_> = filters
                .iter()
                .map(|(name, pattern)| COMDLG_FILTERSPEC {
                    pszName: PCWSTR(name.as_ptr()),
                    pszSpec: PCWSTR(pattern.as_ptr()),
                })
                .collect();
            if !filter_specs.is_empty() {
                dialog.SetFileTypes(&filter_specs)?;
            }
            let customize: IFileDialogCustomize = dialog.cast()?;
            customize.AddPushButton(SELECT_ITEM, &HSTRING::from(&options.select_label))?;
            customize.MakeProminent(SELECT_ITEM)?;
            customize.SetControlState(SELECT_ITEM, CDCS_VISIBLE)?;
            let selection = Rc::new(RefCell::new(None));
            let events: IFileDialogEvents = SelectionEvents {
                selection: selection.clone(),
            }
            .into();
            let cookie = dialog.Advise(&events)?;
            let shown = dialog.Show(Some(hwnd));
            let cleanup = dialog.Unadvise(cookie);
            if let Err(error) = shown {
                if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                    cleanup?;
                    return Ok(None);
                }
                return Err(error);
            }
            cleanup?;
            if let Some(result) = selection.borrow_mut().take() {
                return result.map(Some);
            }
            // The standard Open action (or double-click) confirmed a file.
            item_paths(&dialog.GetResults()?).map(Some)
        }
    };
    let result = run().map_err(|error| error.to_string());
    #[cfg(feature = "debug-control")]
    super::debug_windows::completed(&dialog_id, &result);
    result
}
