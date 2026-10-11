//! AppKit executor only: no model, Agent Loop, permissions policy or Session state.
#[cfg(target_os = "macos")]
mod driver;
#[cfg(target_os = "macos")]
mod indicator;
#[cfg(target_os = "macos")]
mod runtime;
#[cfg(target_os = "macos")]
mod window_identity;

#[cfg(target_os = "macos")]
fn main() {
    if let Err(error) = runtime::run() {
        eprintln!("computer_use_start_failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Native Computer Use currently requires macOS.");
    std::process::exit(1);
}
