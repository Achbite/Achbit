use sha2::{Digest, Sha256};

mod catalog;
pub mod file_content;
mod invocation_adapter;
mod invocation_types;
mod registrations;
mod types;

pub use catalog::{KernelToolCatalogError, KernelToolRegistry};
pub use types::{
    ToolAvailability, ToolDescriptor, ToolEffectClass, ToolEffectScope, ToolInputIssue,
};

/// Kernel-private, cross-crate adapter types.
///
/// Agent-facing callers use tool names plus raw JSON arguments through
/// `KernelToolRegistry`; this module is only the typed executor boundary.
#[doc(hidden)]
pub mod kernel_internal {
    pub use crate::invocation_adapter::{
        canonicalize_invocation, normalize_workspace_path, InvocationNormalizationError,
    };
    pub use crate::invocation_types::{
        KernelCanonicalInvocation, KernelDeleteTarget, KernelExecutionScope, KernelTextEdit,
        KernelToolKind, KernelWorkspaceMode, MAX_CANONICAL_INVOCATION_BYTES,
        MAX_TERMINAL_STDIN_BYTES,
    };
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut output = String::with_capacity(digest.len() * 2 + 7);
    output.push_str("sha256:");
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

pub mod text_range;
