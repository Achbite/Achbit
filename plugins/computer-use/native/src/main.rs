//! Native desktop executor only: no model, Agent Loop, permissions policy or Session state.
#[cfg(target_os = "macos")]
mod driver;
#[cfg(target_os = "macos")]
mod indicator;
#[cfg_attr(not(windows), allow(dead_code))]
mod protocol;
#[cfg(target_os = "macos")]
mod runtime;
#[cfg(target_os = "macos")]
mod sharing;
#[cfg(windows)]
mod win;
#[cfg(target_os = "macos")]
mod window_identity;

#[cfg(target_os = "macos")]
fn main() {
    if let Err(error) = runtime::run() {
        eprintln!("computer_use_start_failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = win::run() {
        eprintln!("computer_use_start_failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn main() {
    eprintln!("Native Computer Use currently requires macOS or Windows.");
    std::process::exit(1);
}
