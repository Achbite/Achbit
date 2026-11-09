//! Host-owned idle-sleep inhibition. Session/Kernel remain the activity authorities.
use crate::{wait_for_host_shutdown, HostState};
use std::future::Future;
use tokio::sync::broadcast;

#[cfg(target_os = "macos")]
#[path = "host_power/macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "host_power/windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "host_power/linux.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod platform {
    pub(super) struct Lease;
    impl Lease {
        pub(super) async fn acquire() -> Result<Self, String> {
            Err("idle sleep inhibition is unavailable on this platform".into())
        }
    }
    impl super::Lease for Lease {
        async fn release(&mut self) -> Result<(), String> {
            Ok(())
        }
        async fn failed(&mut self) -> String {
            std::future::pending().await
        }
    }
}

trait Lease {
    async fn release(&mut self) -> Result<(), String>;
    async fn failed(&mut self) -> String;
}

struct Power<L: Lease> {
    lease: Option<L>,
    unavailable: bool,
}
impl<L: Lease> Default for Power<L> {
    fn default() -> Self {
        Self {
            lease: None,
            unavailable: false,
        }
    }
}
impl<L: Lease> Power<L> {
    async fn update(
        &mut self,
        wanted: bool,
        acquire: impl Future<Output = Result<L, String>>,
    ) -> Result<(), String> {
        if self.unavailable {
            return Ok(());
        }
        if wanted && self.lease.is_none() {
            match acquire.await {
                Ok(lease) => self.lease = Some(lease),
                Err(error) => {
                    self.unavailable = true;
                    return Err(error);
                }
            }
        } else if !wanted {
            if let Some(mut lease) = self.lease.take() {
                if let Err(error) = lease.release().await {
                    self.unavailable = true;
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    async fn failed(&mut self) -> String {
        match self.lease.as_mut() {
            Some(lease) => lease.failed().await,
            None => std::future::pending().await,
        }
    }
    async fn disable(&mut self) {
        self.unavailable = true;
        if let Some(mut lease) = self.lease.take() {
            if let Err(error) = lease.release().await {
                eprintln!("host_power_release_failed: {error}");
            }
        }
    }
}

pub(crate) async fn monitor_host_power(state: HostState) {
    if let Err(error) = observe(&state).await {
        // Power capability failure must not cancel the user's work or stop the Host.
        eprintln!("host_power_unavailable: {error}");
    }
}

async fn observe(state: &HostState) -> Result<(), String> {
    let services = tokio::select! {
        _ = wait_for_host_shutdown() => return Ok(()),
        result = state.execution.wait() => result.map_err(|error| format!("{}: {}", error.code, error.message))?,
    };
    let mut changes = services
        .session_service
        .subscribe_events()
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let kernel_changes = services.local_agent.kernel.activity_changed();
    let mut power = Power::<platform::Lease>::default();
    loop {
        // Subscribe before reading facts. A transition during the read stays pending.
        let kernel_changed = kernel_changes.notified();
        tokio::pin!(kernel_changed);
        kernel_changed.as_mut().enable();
        loop {
            match changes.try_recv() {
                Ok(crate::session_events::SessionNotification::Error { code, message }) => {
                    return Err(format!("{code}: {message}"))
                }
                Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(broadcast::error::TryRecvError::Empty) => break,
                Err(broadcast::error::TryRecvError::Closed) => {
                    return Err("Session activity notifications closed".into())
                }
            }
        }
        let service = services.session_service.clone();
        let activity = tokio::select! {
            _ = wait_for_host_shutdown() => { power.disable().await; return Ok(()); },
            result = tokio::task::spawn_blocking(move || service.request("activity", serde_json::json!({}))) => {
                result.map_err(|error| error.to_string())?
                    .map_err(|error| format!("{}: {}", error.code, error.message))?
            }
        };
        let awake = activity
            .get("keepAwake")
            .and_then(serde_json::Value::as_bool)
            .ok_or("Invalid Session keepAwake activity response")?;
        let executing = services
            .local_agent
            .kernel
            .has_active_work()
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        tokio::select! {
            _ = wait_for_host_shutdown() => { power.disable().await; return Ok(()); },
            result = power.update(awake || executing, platform::Lease::acquire()) => {
                if let Err(error) = result { eprintln!("host_power_unavailable: {error}"); }
            },
        }
        tokio::select! {
            _ = wait_for_host_shutdown() => { power.disable().await; return Ok(()); },
            _ = &mut kernel_changed => {},
            event = changes.recv() => match event {
                Ok(crate::session_events::SessionNotification::Error { code, message }) => return Err(format!("{code}: {message}")),
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {},
                Err(broadcast::error::RecvError::Closed) => return Err("Session activity notifications closed".into()),
            },
            error = power.failed() => {
                eprintln!("host_power_unavailable: {error}");
                power.disable().await;
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct Held(Arc<AtomicUsize>);
    impl Drop for Held {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    impl Lease for Held {
        async fn release(&mut self) -> Result<(), String> {
            Ok(())
        }
        async fn failed(&mut self) -> String {
            std::future::pending().await
        }
    }
    #[tokio::test]
    async fn host_power_releases_on_idle_and_owner_drop_without_duplicate_acquisition() {
        let held = Arc::new(AtomicUsize::new(0));
        let mut power = Power::<Held>::default();
        let acquire = || async {
            held.fetch_add(1, Ordering::SeqCst);
            Ok(Held(held.clone()))
        };
        power.update(true, acquire()).await.unwrap();
        power.update(true, acquire()).await.unwrap();
        assert_eq!(held.load(Ordering::SeqCst), 1);
        power.update(false, acquire()).await.unwrap();
        assert_eq!(held.load(Ordering::SeqCst), 0);
        power.update(true, acquire()).await.unwrap();
        drop(power);
        assert_eq!(held.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn host_power_capability_failure_is_reported_once_without_retrying_user_work() {
        let attempts = AtomicUsize::new(0);
        let mut power = Power::<Held>::default();
        let acquire = || async {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err("OS refused the assertion".into())
        };
        assert_eq!(
            power.update(true, acquire()).await.unwrap_err(),
            "OS refused the assertion"
        );
        for wanted in [true, false, true] {
            power.update(wanted, acquire()).await.unwrap();
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }
}
