use super::*;
use achbit_kernel_abi::{
    HostProcessIdentity, HOST_INSTANCE_ID_ENV, HOST_INSTANCE_ID_PREFIX, HOST_SHELL_TOKEN_PREFIX,
    HOST_TOKEN_ENTROPY_BYTES, KERNEL_DAEMON_SERVICE,
};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use achbit_host_connection::process::{terminate_owned_process_tree_until, OwnedHostProcess};
use achbit_host_connection::{startup, HostClientLease, HOST_LIFETIME_ENV};
#[cfg(all(test, unix))]
use std::os::unix::process::CommandExt;

#[derive(Clone)]
pub struct KernelBootstrapOptions {
    pub api: Option<String>,
    pub auto_start: bool,
    pub persistent: bool,
    host_shell_token: Option<HostShellToken>,
}

impl fmt::Debug for KernelBootstrapOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KernelBootstrapOptions")
            .field("api", &self.api)
            .field("auto_start", &self.auto_start)
            .field(
                "host_shell_token",
                &self.host_shell_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

impl KernelBootstrapOptions {
    pub fn new(api: Option<String>) -> Self {
        Self {
            api,
            auto_start: true,
            persistent: false,
            host_shell_token: None,
        }
    }

    pub fn auto_start(mut self, auto_start: bool) -> Self {
        self.auto_start = auto_start;
        self
    }

    pub fn persistent(mut self, persistent: bool) -> Self {
        self.persistent = persistent;
        self
    }

    pub fn host_shell_token(mut self, token: impl Into<String>) -> Self {
        self.host_shell_token = Some(HostShellToken::new(token));
        self
    }
}

pub struct KernelBootstrap {
    client: HttpKernelClient,
    _guard: KernelBootstrapGuard,
    _client_lease: HostClientLease,
}

impl KernelBootstrap {
    fn attached(
        client: HttpKernelClient,
        mut guard: KernelBootstrapGuard,
        connection: &KernelClientConfig,
        persistent: bool,
        deadline: Instant,
    ) -> KernelClientResult<Self> {
        let token = connection
            .host_shell_token
            .as_ref()
            .ok_or(KernelClientError::HostConnectionTokenMissing)?;
        let lease = HostClientLease::connect_until(
            &client.config.base_url,
            token.expose_to_transport(),
            persistent,
            deadline,
        )
        .map_err(|error| {
            let cleanup = guard
                .process
                .as_mut()
                .and_then(|process| terminate_owned_process_tree_until(process, deadline).err());
            KernelClientError::Bootstrap(format!(
                "Host client registration failed: {error}{}",
                cleanup
                    .map(|error| format!("; owned tree cleanup failed: {error}"))
                    .unwrap_or_default()
            ))
        })?;
        Ok(Self {
            client,
            _guard: guard,
            _client_lease: lease,
        })
    }

    pub async fn connect(options: KernelBootstrapOptions) -> KernelClientResult<Self> {
        let deadline = Instant::now() + startup::STARTUP_BUDGET;
        let implicit_endpoint = options.api.is_none()
            && std::env::var_os("ACHBIT_API_URL").is_none()
            && std::env::var_os("ACHBIT_PORT").is_none();
        let _shared_start_guard;
        let shared_connection = if implicit_endpoint {
            let directories = achbit_host_connection::UserDirectories::resolve()
                .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
            let root = directories.data_dir;
            _shared_start_guard = Some(
                achbit_host_connection::HostStartGuard::acquire_until(&root, deadline)
                    .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?,
            );
            achbit_host_connection::LocalHostConnection::discover_until(&root, deadline)
                .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?
        } else {
            _shared_start_guard = None;
            None
        };
        let mut config = options
            .api
            .map(KernelClientConfig::new)
            .unwrap_or_else(KernelClientConfig::from_env);
        if let Some(connection) = shared_connection {
            config.base_url = connection.identity.address.clone();
            if !config.has_host_shell_token() {
                config = config.with_host_shell_token(connection.shell_token());
            }
        } else if implicit_endpoint && kernel_auto_start_enabled(options.auto_start) {
            // A different config root may already use the conventional port.
            // New shared Hosts receive a private port; other shells discover it.
            let host = std::env::var("ACHBIT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
            let listener = std::net::TcpListener::bind((host.as_str(), 0))
                .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
            let address = listener
                .local_addr()
                .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
            config.base_url = format!("http://{address}");
        }
        if let Some(token) = options.host_shell_token {
            config.host_shell_token = Some(token);
        }
        config.validate_host_shell_token()?;
        if !is_local_kernel_url(&config.base_url) {
            if !config.has_host_shell_token() {
                return Err(KernelClientError::HostConnectionTokenMissing);
            }
            return Err(KernelClientError::DaemonUnavailable {
                base_url: config.base_url.clone(),
                reason: "Host connection is restricted to a local Kernel URL".to_string(),
            });
        }
        if let Some(client) = probe_existing_kernel(&config, deadline).await? {
            return Self::attached(
                client,
                KernelBootstrapGuard::external(),
                &config,
                options.persistent,
                deadline,
            );
        }

        if !kernel_auto_start_enabled(options.auto_start) {
            if !config.has_host_shell_token() {
                return Err(KernelClientError::HostConnectionTokenMissing);
            }
            return Err(KernelClientError::DaemonUnavailable {
                base_url: config.base_url.clone(),
                reason: "automatic startup is disabled".to_string(),
            });
        }

        let (host, port) = parse_kernel_host_port(&config.base_url).ok_or_else(|| {
            KernelClientError::Bootstrap(format!(
                "cannot resolve local host/port from {}",
                config.base_url
            ))
        })?;
        let Some(_start_lock) = acquire_kernel_start_lock(&host, &port)? else {
            if !config.has_host_shell_token() {
                return Err(KernelClientError::HostConnectionTokenMissing);
            }
            loop {
                if let Some(client) = probe_existing_kernel(&config, deadline).await? {
                    return Self::attached(
                        client,
                        KernelBootstrapGuard::external(),
                        &config,
                        options.persistent,
                        deadline,
                    );
                }
                if Instant::now() >= deadline {
                    break;
                }
                startup::pause(deadline);
            }
            return Err(KernelClientError::DaemonUnavailable {
                base_url: config.base_url.clone(),
                reason: "another owner is starting the Kernel, but its authenticated health endpoint did not become ready".to_string(),
            });
        };
        if let Some(client) = probe_existing_kernel(&config, deadline).await? {
            return Self::attached(
                client,
                KernelBootstrapGuard::external(),
                &config,
                options.persistent,
                deadline,
            );
        }
        let kernel_bin = find_kernel_binary()?.ok_or_else(|| {
            KernelClientError::Bootstrap(
                "cannot find achbit-kernel or achbit-kernel-daemon; set ACHBIT_KERNEL_BIN"
                    .to_string(),
            )
        })?;
        let owned_token = generate_local_token(HOST_SHELL_TOKEN_PREFIX)?;
        let owned_instance_id = generate_local_token(HOST_INSTANCE_ID_PREFIX)?;
        let (mut command, log_path) =
            kernel_command(&kernel_bin, &host, &port, &owned_token, &owned_instance_id)?;
        let owned_config = config.with_host_shell_token(owned_token.clone());
        let client = HttpKernelClient::new(owned_config.clone())?;
        let (process, _) = startup::start_owned_ready(&mut command, deadline, |process, probe_deadline| {
            let target = owned_kernel_startup_target(&host, port.parse().expect("validated port"), &owned_instance_id, process.child.id());
            let identity = startup_kernel_identity(&target, probe_deadline)?;
            let request = format!("GET /api/health HTTP/1.1\r\nHost: {host}:{port}\r\n{HOST_SHELL_TOKEN_HEADER}: {owned_token}\r\nConnection: close\r\n\r\n");
            let value = achbit_host_connection::loopback_http::request_loopback_json_until(&host, &port, &request, probe_deadline)?;
            let health = decode_health(value).map_err(std::io::Error::other)?;
            if !health.ok { return Err(std::io::Error::other("Kernel health endpoint reported an unhealthy state")); }
            Ok(identity)
        }).map_err(|error| KernelClientError::Bootstrap(format!("{error}; log: {}", log_path.display())))?;
        #[cfg(windows)]
        if let Err(error) = process.job.release_on_close() {
            let mut process = process;
            let cleanup = terminate_owned_process_tree_until(&mut process, deadline).err();
            return Err(KernelClientError::Bootstrap(format!(
                "{error}; cleanup: {cleanup:?}"
            )));
        }
        Self::attached(
            client,
            KernelBootstrapGuard::owned(process),
            &owned_config,
            options.persistent,
            deadline,
        )
    }

    pub fn client(&self) -> &HttpKernelClient {
        &self.client
    }
}

pub struct KernelBootstrapGuard {
    process: Option<OwnedHostProcess>,
}

impl KernelBootstrapGuard {
    fn external() -> Self {
        Self { process: None }
    }

    fn owned(process: OwnedHostProcess) -> Self {
        Self {
            process: Some(process),
        }
    }
}

impl Drop for KernelBootstrapGuard {
    fn drop(&mut self) {
        // The connection lease notifies the Host; only the Host decides whether work permits exit.
        drop(self.process.take());
    }
}

struct OwnedKernelStartupTarget {
    host: String,
    port: u16,
    expected_instance_id: String,
    expected_pid: u32,
}

#[derive(Deserialize)]
struct HostApiEnvelope<T> {
    ok: bool,
    data: Option<T>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub service: String,
    pub ok: bool,
    pub raw: Value,
}

/// Absence permits startup; a listener's authentication and health failures do not.
async fn probe_existing_kernel(
    config: &KernelClientConfig,
    deadline: Instant,
) -> KernelClientResult<Option<HttpKernelClient>> {
    if !probe_kernel_tcp(&config.base_url, deadline)? {
        return Ok(None);
    }
    if !config.has_host_shell_token() {
        return Err(KernelClientError::HostConnectionTokenMissing);
    }
    let client = HttpKernelClient::new(config.clone())?;
    let timeout = startup::remaining(deadline)
        .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
    let health = async {
        let value = client
            .http
            .get(client.url("/api/health"))
            .timeout(timeout)
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        decode_health(value)
    }
    .await;
    let reason = match health {
        Ok(status) if status.ok => return Ok(Some(client)),
        Ok(_) => "Kernel health endpoint reported an unhealthy state".to_string(),
        Err(KernelClientError::Http(error))
            if error.status() == Some(reqwest::StatusCode::UNAUTHORIZED) =>
        {
            return Err(KernelClientError::HostConnectionRejected {
                base_url: config.base_url.clone(),
            });
        }
        Err(error) => error.to_string(),
    };
    Err(KernelClientError::DaemonUnavailable {
        base_url: config.base_url.clone(),
        reason,
    })
}

fn generate_local_token(prefix: &str) -> KernelClientResult<String> {
    let mut entropy = [0_u8; HOST_TOKEN_ENTROPY_BYTES];
    getrandom::fill(&mut entropy).map_err(|error| {
        KernelClientError::Bootstrap(format!(
            "operating-system CSPRNG could not create a Host connection token: {error}"
        ))
    })?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(prefix.len() + entropy.len() * 2);
    encoded.push_str(prefix);
    for &byte in &entropy {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    entropy.fill(0);
    Ok(encoded)
}

fn probe_kernel_tcp(base_url: &str, deadline: Instant) -> KernelClientResult<bool> {
    let (host, port) = parse_kernel_host_port(base_url).ok_or_else(|| {
        KernelClientError::Bootstrap(format!("Cannot resolve Host address from {base_url}"))
    })?;
    let timeout = startup::remaining(deadline)
        .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?
        .min(Duration::from_millis(180));
    match achbit_host_connection::loopback_http::connect_loopback(&host, &port, timeout) {
        Ok(_) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::TimedOut
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(KernelClientError::Bootstrap(error.to_string())),
    }
}

fn kernel_auto_start_enabled(default_enabled: bool) -> bool {
    match std::env::var("ACHBIT_KERNEL_AUTO_START") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "no" | "off")
        }
        Err(_) => default_enabled,
    }
}

fn parse_kernel_host_port(base_url: &str) -> Option<(String, String)> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let (scheme, rest) = trimmed.split_once("://")?;
    let target = rest.split('/').next()?.split('@').next_back()?;
    if target.is_empty() {
        return None;
    }
    if let Some(after_bracket) = target.strip_prefix('[') {
        let (host, tail) = after_bracket.split_once(']')?;
        let port = tail
            .strip_prefix(':')
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| default_port_for_scheme(scheme).to_string());
        return Some((host.to_string(), port));
    }
    let (host, port) = target
        .rsplit_once(':')
        .map(|(host, port)| (host.to_string(), port.to_string()))
        .unwrap_or_else(|| {
            (
                target.to_string(),
                default_port_for_scheme(scheme).to_string(),
            )
        });
    Some((host, port))
}

fn default_port_for_scheme(scheme: &str) -> &'static str {
    if scheme.eq_ignore_ascii_case("https") {
        "443"
    } else {
        "80"
    }
}

fn is_local_kernel_url(base_url: &str) -> bool {
    let Some((host, _)) = parse_kernel_host_port(base_url) else {
        return false;
    };
    matches!(
        host.trim_matches(|ch| ch == '[' || ch == ']')
            .to_ascii_lowercase()
            .as_str(),
        "localhost" | "127.0.0.1" | "::1" | "0.0.0.0"
    )
}

fn find_kernel_binary() -> KernelClientResult<Option<PathBuf>> {
    if let Some(path) = achbit_host_connection::configured_path("ACHBIT_KERNEL_BIN")
        .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?
    {
        if path.is_file() {
            return Ok(Some(path));
        }
        return Err(KernelClientError::Bootstrap(format!(
            "ACHBIT_KERNEL_BIN points to a missing file: {}",
            path.display()
        )));
    }

    let executable =
        std::env::current_exe().map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
    let directory = executable.parent().ok_or_else(|| {
        KernelClientError::Bootstrap("executable directory is unavailable".into())
    })?;
    let candidate = directory.join(format!("achbit-kernel{}", std::env::consts::EXE_SUFFIX));
    Ok(candidate.is_file().then_some(candidate))
}

fn kernel_command(
    kernel_bin: &Path,
    host: &str,
    port: &str,
    host_shell_token: &str,
    host_instance_id: &str,
) -> KernelClientResult<(Command, PathBuf)> {
    port.parse::<u16>().map_err(|_| {
        KernelClientError::Bootstrap("Kernel port is not a valid TCP port".to_string())
    })?;
    let kernel_dir = kernel_bin
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let directories = achbit_host_connection::UserDirectories::resolve()
        .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
    let (log_file, log_path) = open_kernel_log_file(&directories.log_dir)?;
    let stderr = log_file.try_clone().map_err(|error| {
        KernelClientError::Bootstrap(format!("failed to clone kernel log handle: {error}"))
    })?;
    let mut command = Command::new(kernel_bin);
    directories.configure_child(&mut command);
    let resources = achbit_host_connection::runtime_root(&kernel_dir)
        .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
    achbit_host_connection::configure_runtime_child(&mut command, &resources)
        .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
    command
        .current_dir(&kernel_dir)
        .env("ACHBIT_HOST", host)
        .env("ACHBIT_PORT", port)
        .env(HOST_SHELL_TOKEN_ENV, host_shell_token)
        .env(HOST_INSTANCE_ID_ENV, host_instance_id)
        .env(HOST_LIFETIME_ENV, "automatic")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr));

    Ok((command, log_path))
}

fn owned_kernel_startup_target(
    host: &str,
    port: u16,
    host_instance_id: &str,
    pid: u32,
) -> OwnedKernelStartupTarget {
    OwnedKernelStartupTarget {
        host: host.to_string(),
        port,
        expected_instance_id: host_instance_id.to_string(),
        expected_pid: pid,
    }
}

fn startup_kernel_identity(
    target: &OwnedKernelStartupTarget,
    deadline: Instant,
) -> std::io::Result<HostProcessIdentity> {
    let request = format!(
        "GET /api/host/identity HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n",
        target.host, target.port
    );
    let envelope: HostApiEnvelope<HostProcessIdentity> =
        achbit_host_connection::loopback_http::request_loopback_json_until(
            &target.host,
            &target.port.to_string(),
            &request,
            deadline,
        )?;
    let identity = envelope.data.filter(|_| envelope.ok).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "owned Kernel identity response is missing data",
        )
    })?;
    if identity.service != KERNEL_DAEMON_SERVICE
        || identity.instance_id != target.expected_instance_id
        || identity.pid != target.expected_pid
        || !is_local_kernel_url(&identity.address)
        || parse_kernel_host_port(&identity.address).and_then(|(_, port)| port.parse::<u16>().ok())
            != Some(target.port)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "owned Kernel public identity did not match its startup target",
        ));
    }
    Ok(identity)
}

fn acquire_kernel_start_lock(
    host: &str,
    port: &str,
) -> KernelClientResult<Option<achbit_host_connection::HostStartGuard>> {
    let temporary = achbit_host_connection::UserDirectories::resolve()
        .map(|directories| directories.temp_dir)
        .map_err(|error| KernelClientError::Bootstrap(error.to_string()))?;
    achbit_host_connection::HostStartGuard::try_acquire_port(&temporary, host, port)
        .map_err(|error| KernelClientError::Bootstrap(error.to_string()))
}

fn open_kernel_log_file(log_dir: &Path) -> KernelClientResult<(File, PathBuf)> {
    open_log_in_dir(log_dir).map_err(|error| {
        KernelClientError::Bootstrap(format!(
            "failed to open kernel log at {}: {error}",
            log_dir.display()
        ))
    })
}

fn open_log_in_dir(log_dir: &Path) -> std::io::Result<(File, PathBuf)> {
    std::fs::create_dir_all(log_dir)?;
    let path = log_dir.join("achbit-kernel.log");
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    Ok((file, path))
}

#[cfg(all(test, unix))]
mod ownership_tests {
    use super::*;

    #[tokio::test]
    async fn startup_external_health_obeys_remaining_deadline_without_terminating_host() {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let _probe = listener.accept().unwrap();
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            stream.read(&mut request).unwrap();
            std::thread::sleep(Duration::from_millis(250));
            listener
        });
        let token = generate_local_token(HOST_SHELL_TOKEN_PREFIX).unwrap();
        let config =
            KernelClientConfig::new(format!("http://{address}")).with_host_shell_token(token);
        let start = Instant::now();
        let result = probe_existing_kernel(&config, start + Duration::from_millis(100)).await;
        assert!(matches!(
            result,
            Err(KernelClientError::DaemonUnavailable { .. })
        ));
        assert!(start.elapsed() < Duration::from_millis(250));
        let listener = server.join().unwrap();
        assert_eq!(listener.local_addr().unwrap(), address);
    }

    #[test]
    fn closing_a_client_leaves_the_ready_host_running() {
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id() as libc::pid_t;
        let guard = KernelBootstrapGuard::owned(OwnedHostProcess {
            child,
            process_group_id: pid,
        });
        drop(guard);
        let mut status = 0;
        let still_running = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) == 0 };
        // Reclaim only this test's child, including when the assertion fails.
        if still_running {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                libc::waitpid(pid, &mut status, 0);
            }
        }
        assert!(
            still_running,
            "a client exit must not terminate the shared Host"
        );
    }
}
