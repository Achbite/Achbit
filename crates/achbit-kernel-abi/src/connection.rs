use serde::{Deserialize, Serialize};

pub const HOST_SHELL_TOKEN_ENV: &str = "ACHBIT_HOST_SHELL_TOKEN";
pub const HOST_UI_TOKEN_ENV: &str = "ACHBIT_HOST_UI_TOKEN";
pub const HOST_INSTANCE_ID_ENV: &str = "ACHBIT_HOST_INSTANCE_ID";
pub const HOST_SHELL_TOKEN_HEADER: &str = "x-achbit-host-shell-token";
pub const HOST_UI_TOKEN_HEADER: &str = "x-achbit-host-ui-token";
pub const HOST_SHELL_TOKEN_PREFIX: &str = "dchost_";
pub const HOST_UI_TOKEN_PREFIX: &str = "dcui_";
pub const HOST_INSTANCE_ID_PREFIX: &str = "dcinstance_";
pub const HOST_TOKEN_ENTROPY_BYTES: usize = 32;
pub const KERNEL_DAEMON_SERVICE: &str = "achbit-kernel-daemon";
pub const HOST_SHUTDOWN_OWNER: &str = "hostShell";
pub const HOST_SHUTDOWN_IDENTITY_CONFLICT: &str = "host_shutdown_identity_conflict";
// Includes Session cancellation and the subsequent Kernel/plugin cleanup.
pub const HOST_SHUTDOWN_RECEIPT_TIMEOUT_MILLIS: u64 = 90_000;

pub fn is_valid_host_shell_token(value: &str) -> bool {
    is_valid_local_token(value, HOST_SHELL_TOKEN_PREFIX)
}

pub fn is_valid_host_ui_token(value: &str) -> bool {
    is_valid_local_token(value, HOST_UI_TOKEN_PREFIX)
}

pub fn is_valid_host_instance_id(value: &str) -> bool {
    is_valid_local_token(value, HOST_INSTANCE_ID_PREFIX)
}

fn is_valid_local_token(value: &str, prefix: &str) -> bool {
    let Some(encoded) = value.strip_prefix(prefix) else {
        return false;
    };
    encoded.len() == HOST_TOKEN_ENTROPY_BYTES * 2
        && encoded
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostProcessIdentity {
    pub service: String,
    pub instance_id: String,
    pub pid: u32,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostShutdownRequest {
    pub expected_identity: HostProcessIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostShutdownReceipt {
    pub accepted: bool,
    pub owner: String,
    pub identity: HostProcessIdentity,
    pub cleanup_complete: bool,
}

impl HostShutdownReceipt {
    pub fn confirms_shutdown_of(&self, expected_identity: &HostProcessIdentity) -> bool {
        self.accepted
            && self.owner == HOST_SHUTDOWN_OWNER
            && self.cleanup_complete
            && &self.identity == expected_identity
    }
}
