//! Physical Host lifetime. Session remains the sole owner of active work.
use crate::prelude::*;
use crate::{
    request_host_shutdown, shutdown_owned_host_resources, wait_for_host_shutdown, AppState,
};
use axum::body::Body;
use std::convert::Infallible;
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct Lifetime {
    persistent: bool,
    admitted: bool,
    clients: usize,
    revision: u64,
    stopping: bool,
}

impl Lifetime {
    fn attach(&mut self, persistent: bool) -> bool {
        if self.stopping {
            return false;
        }
        self.persistent |= persistent;
        self.admitted = true;
        self.clients += 1;
        self.revision += 1;
        true
    }

    fn detach(&mut self) {
        self.clients = self.clients.checked_sub(1).expect("registered Host client");
        self.revision += 1;
    }

    fn idle_revision(&self) -> Option<u64> {
        (!self.persistent && self.admitted && self.clients == 0 && !self.stopping)
            .then_some(self.revision)
    }

    fn stop_if_idle(&mut self, revision: u64, active: bool) -> bool {
        if active || self.idle_revision() != Some(revision) {
            return false;
        }
        self.stopping = true;
        true
    }
}

static LIFETIME: OnceLock<Mutex<Lifetime>> = OnceLock::new();

pub(crate) fn configure_host_lifetime() -> Result<(), String> {
    let mode = std::env::var(achbit_host_connection::HOST_LIFETIME_ENV)
        .unwrap_or_else(|_| "persistent".into());
    let persistent = match mode.as_str() {
        "automatic" => false,
        "persistent" => true,
        _ => return Err("DEEPCODE_HOST_LIFETIME must be automatic or persistent".into()),
    };
    LIFETIME
        .set(Mutex::new(Lifetime {
            persistent,
            ..Default::default()
        }))
        .map_err(|_| "Host lifetime already configured".into())
}

struct RegisteredClient;
impl Drop for RegisteredClient {
    fn drop(&mut self) {
        LIFETIME
            .get()
            .expect("Host lifetime configured")
            .lock()
            .expect("Host lifetime lock")
            .detach();
    }
}

#[derive(Deserialize)]
pub(crate) struct ClientQuery {
    mode: String,
}

pub(crate) async fn host_client(Query(query): Query<ClientQuery>) -> Response {
    let persistent = match query.mode.as_str() {
        "client" => false,
        "persistent" => true,
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    if !LIFETIME
        .get()
        .expect("Host lifetime configured")
        .lock()
        .expect("Host lifetime lock")
        .attach(persistent)
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let client = RegisteredClient;
    let stream = async_stream::stream! {
        let _client = client;
        yield Ok::<_, Infallible>(bytes::Bytes::from_static(b"attached\n"));
        wait_for_host_shutdown().await;
    };
    Response::builder()
        .header("content-type", "application/octet-stream")
        .body(Body::from_stream(stream))
        .expect("Host client response")
}

pub(crate) async fn monitor_host_lifetime(state: AppState) {
    if let Err(error) = observe_host_lifetime(&state).await {
        if !begin_host_shutdown() {
            return;
        }
        eprintln!("host_lifecycle_failed: {error}");
        // A dead Session cannot own more work. Release this Host's resources
        // before the next normal startup can acquire the data-root lease.
        shutdown_owned_host_resources(&state).await;
        request_host_shutdown();
    }
}

pub(crate) fn begin_host_shutdown() -> bool {
    let Some(lifetime) = LIFETIME.get() else {
        return false;
    };
    let mut lifetime = lifetime.lock().expect("Host lifetime lock");
    let started = !lifetime.stopping;
    lifetime.stopping = true;
    started
}

async fn observe_host_lifetime(state: &AppState) -> Result<(), String> {
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if LIFETIME
            .get()
            .expect("Host lifetime configured")
            .lock()
            .expect("Host lifetime lock")
            .stopping
        {
            return Ok(());
        }
        let service = state.session_service.clone();
        tokio::task::spawn_blocking(move || service.check_ready())
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        let revision = LIFETIME
            .get()
            .expect("Host lifetime configured")
            .lock()
            .expect("Host lifetime lock")
            .idle_revision();
        let Some(revision) = revision else {
            continue;
        };
        let service = state.session_service.clone();
        let result =
            tokio::task::spawn_blocking(move || service.request("activity", json!({}))).await;
        let active = match result {
            Ok(Ok(value)) => match value.get("active").and_then(Value::as_bool) {
                Some(active) => active,
                None => {
                    return Err("host_lifecycle_activity_invalid".into());
                }
            },
            error => {
                return Err(format!("host_lifecycle_activity_failed: {error:?}"));
            }
        };
        if LIFETIME
            .get()
            .expect("Host lifetime configured")
            .lock()
            .expect("Host lifetime lock")
            .stop_if_idle(revision, active)
        {
            request_host_shutdown();
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn client_socket_drop_releases_only_that_registered_client() {
        let state = LIFETIME.get_or_init(|| Mutex::new(Lifetime::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/api/host/client", get(host_client)),
            )
            .await
            .unwrap();
        });
        let connect = |url: String| {
            tokio::task::spawn_blocking(move || {
                achbit_host_connection::HostClientLease::connect(
                    &url,
                    &format!("dchost_{}", "a".repeat(64)),
                    false,
                )
                .unwrap()
            })
        };
        let first = connect(url.clone()).await.unwrap();
        let second = connect(url).await.unwrap();
        assert_eq!(state.lock().unwrap().clients, 2);
        drop(first);
        tokio::time::timeout(Duration::from_secs(2), async {
            while state.lock().unwrap().clients != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(state.lock().unwrap().idle_revision(), None);
        drop(second);
        tokio::time::timeout(Duration::from_secs(2), async {
            while state.lock().unwrap().clients != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(state.lock().unwrap().idle_revision().is_some());
        server.abort();
        let _ = server.await;
    }

    #[test]
    fn automatic_host_waits_for_clients_and_background_work() {
        let mut state = Lifetime::default();
        assert_eq!(state.idle_revision(), None);
        assert!(state.attach(false));
        assert!(state.attach(false));
        state.detach();
        assert_eq!(state.idle_revision(), None);
        state.detach();
        let revision = state.idle_revision().unwrap();
        assert!(!state.stop_if_idle(revision, true));
        assert!(state.stop_if_idle(revision, false));
        assert!(!state.attach(false));
    }

    #[test]
    fn reconnect_and_explicit_service_prevent_idle_shutdown() {
        let mut state = Lifetime::default();
        state.attach(false);
        state.detach();
        let revision = state.idle_revision().unwrap();
        state.attach(false);
        state.detach();
        assert!(!state.stop_if_idle(revision, false));
        state.attach(true);
        state.detach();
        assert_eq!(state.idle_revision(), None);
    }
}
