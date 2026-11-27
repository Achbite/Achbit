//! Only repeat the read-only manifest check, never a download or installation.
use std::{error::Error as StdError, io, time::Duration};
use tauri_plugin_updater::{Error, Result, Update, Updater};

// Even with both retries, a check stays within the previous 180-second budget.
pub(super) const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(45);

pub(super) async fn check(
    updater: &Updater,
    may_retry: impl Fn() -> bool,
) -> Result<Option<Update>> {
    let mut delays = [1, 4].into_iter().map(Duration::from_secs);
    loop {
        let error = match updater.check().await {
            Err(error) if interrupted(&error) && may_retry() => error,
            outcome => return outcome,
        };
        let Some(delay) = delays.next() else {
            return Err(error);
        };
        tokio::time::sleep(delay).await;
        if !may_retry() {
            return Err(error);
        }
        eprintln!(
            "[product-update] retrying feed after {delay:?}: {}",
            super::update_error("Check for updates", error)
        );
    }
}

fn interrupted(error: &Error) -> bool {
    let Error::Reqwest(request) = error else {
        return false;
    };
    if request.is_timeout() {
        return true;
    }
    let mut cause = request.source();
    while let Some(err) = cause {
        if let Some(io) = err.downcast_ref::<io::Error>() {
            if matches!(
                io.kind(),
                io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::ConnectionRefused
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::TimedOut
                    | io::ErrorKind::NotConnected
                    | io::ErrorKind::NetworkUnreachable
                    | io::ErrorKind::HostUnreachable
            ) {
                return true;
            }
            // hyper-rustls wraps the handshake io::Error in io::Error::other;
            // source() alone skips the inner UnexpectedEof. Invalid TLS is not an interruption.
            if let Some(inner) = io.get_ref() {
                cause = Some(inner);
                continue;
            }
        }
        cause = err.source();
    }
    false
}

#[cfg(test)]
mod tests;
