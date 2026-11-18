use super::Snapshot;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, NSObject, Sel},
    DefinedClass, MainThreadOnly,
};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSString};
use objc2_web_kit::WKNavigationDelegate;
use std::ffi::c_void;

// Retain the forwarding delegate on its exact WKWebView, and restore/remove it
// before close. Wry continues to own policy, downloads and successful navigation.
static OWNER_KEY: u8 = 0;
unsafe extern "C" {
    fn objc_setAssociatedObject(
        object: *mut AnyObject,
        key: *const c_void,
        value: *mut AnyObject,
        policy: usize,
    );
    fn objc_getAssociatedObject(object: *mut AnyObject, key: *const c_void) -> *mut AnyObject;
}
const KEYS: &[&str] = &["URL", "title", "canGoBack", "canGoForward"];

struct ObserverState {
    original: Retained<AnyObject>,
    app: tauri::AppHandle,
    id: String,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ObserverState]
    struct BrowserNavigationObserver;

    unsafe impl NSObjectProtocol for BrowserNavigationObserver {
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            unsafe {
                let own: bool = msg_send![super(self), respondsToSelector: selector];
                own || msg_send![&*self.ivars().original, respondsToSelector: selector]
            }
        }
    }
    unsafe impl WKNavigationDelegate for BrowserNavigationObserver {}
    impl BrowserNavigationObserver {
        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target(&self, _selector: Sel) -> *mut AnyObject {
            Retained::as_ptr(&self.ivars().original).cast_mut()
        }
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe(&self, _key: &NSString, object: *mut AnyObject, _change: *mut AnyObject, _context: *mut c_void) {
            let state = self.ivars();
            super::changed(&state.app, &state.id, unsafe { snapshot(object) });
        }
        #[unsafe(method(webView:didStartProvisionalNavigation:))]
        fn navigation_started(&self, _view: *mut AnyObject, _navigation: *mut AnyObject) {
            super::started(&self.ivars().app, &self.ivars().id);
        }
        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn provisional_failure(&self, _view: *mut AnyObject, _navigation: *mut AnyObject, error: *mut AnyObject) {
            self.failure(error);
        }
        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn navigation_failure(&self, _view: *mut AnyObject, _navigation: *mut AnyObject, error: *mut AnyObject) {
            self.failure(error);
        }
    }
);
impl BrowserNavigationObserver {
    fn failure(&self, error: *mut AnyObject) {
        unsafe {
            let code: isize = msg_send![error, code];
            // WebKit also cancels superseded navigations. An explicit stop is
            // recorded by the owning command, not mistaken for a load failure.
            if code == -999 {
                return;
            }
            let domain: *mut NSString = msg_send![error, domain];
            let description: *mut NSString = msg_send![error, localizedDescription];
            super::failed(
                &self.ivars().app,
                &self.ivars().id,
                format!("{} ({code}): {}", text(domain), text(description)),
            );
        }
    }
}
unsafe fn text(value: *mut NSString) -> String {
    value
        .as_ref()
        .map(|value| value.to_string())
        .unwrap_or_default()
}
unsafe fn snapshot(view: *mut AnyObject) -> Snapshot {
    let title: *mut NSString = msg_send![view, title];
    let url: *mut AnyObject = msg_send![view, URL];
    let url = if url.is_null() {
        String::new()
    } else {
        let value: *mut NSString = msg_send![url, absoluteString];
        text(value)
    };
    let back: Bool = msg_send![view, canGoBack];
    let forward: Bool = msg_send![view, canGoForward];
    Snapshot {
        title: text(title),
        url,
        can_go_back: back.as_bool(),
        can_go_forward: forward.as_bool(),
    }
}

pub(super) fn operate(
    native: tauri::webview::PlatformWebview,
    action: &str,
    app: &tauri::AppHandle,
    id: &str,
) -> Result<Snapshot, String> {
    unsafe {
        let view = native.inner().cast::<AnyObject>();
        let key = (&OWNER_KEY as *const u8).cast::<c_void>();
        match action {
            "install" => {
                if objc_getAssociatedObject(view, key).is_null() {
                    let original: *mut AnyObject = msg_send![view, navigationDelegate];
                    let original = Retained::retain(original)
                        .ok_or("native_browser_navigation_delegate_missing")?;
                    let mtm =
                        MainThreadMarker::new().ok_or("native_browser_main_thread_required")?;
                    let observer =
                        mtm.alloc::<BrowserNavigationObserver>()
                            .set_ivars(ObserverState {
                                original,
                                app: app.clone(),
                                id: id.into(),
                            });
                    let observer: Retained<BrowserNavigationObserver> =
                        msg_send![super(observer), init];
                    objc_setAssociatedObject(
                        view,
                        key,
                        Retained::as_ptr(&observer).cast_mut().cast(),
                        1,
                    );
                    let _: () = msg_send![view, setNavigationDelegate: &*observer];
                    for key in KEYS {
                        let _: () = msg_send![view, addObserver: &*observer, forKeyPath: &*NSString::from_str(key), options: 0usize, context: std::ptr::null_mut::<c_void>()];
                    }
                }
            }
            "dispose" => {
                let object =
                    objc_getAssociatedObject(view, key).cast::<BrowserNavigationObserver>();
                if let Some(observer) = object.as_ref() {
                    for key in KEYS {
                        let _: () = msg_send![view, removeObserver: observer, forKeyPath: &*NSString::from_str(key)];
                    }
                    let _: () = msg_send![view, setNavigationDelegate: &*observer.ivars().original];
                    objc_setAssociatedObject(view, key, std::ptr::null_mut(), 1);
                }
            }
            "back" => {
                let _: *mut AnyObject = msg_send![view, goBack];
            }
            "forward" => {
                let _: *mut AnyObject = msg_send![view, goForward];
            }
            "stop" => {
                let _: () = msg_send![view, stopLoading];
            }
            "status" => {}
            _ => return Err("native_browser_navigation_action_invalid".into()),
        }
        Ok(snapshot(view))
    }
}
