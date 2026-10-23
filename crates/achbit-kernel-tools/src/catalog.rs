use crate::invocation_adapter::canonicalize_invocation;
use crate::invocation_types::{KernelCanonicalInvocation, KernelToolKind};
use crate::registrations::{builtin_tool_registrations, KernelToolRegistration};
use crate::types::{ToolAvailability, ToolDescriptor, ToolInputIssue};
use serde_json::Value;
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum KernelToolCatalogError {
    #[error("tool `{0}` is not registered")]
    ToolNotRegistered(String),
    #[error("tool `{0}` is blocked")]
    ToolBlocked(String),
    #[error("tool `{tool_name}` arguments are invalid: {reason}")]
    InvalidArguments {
        tool_name: String,
        reason: String,
        issues: Vec<ToolInputIssue>,
    },
}

#[derive(Debug, Clone)]
pub struct KernelToolRegistry {
    registrations: BTreeMap<&'static str, KernelToolRegistration>,
}

impl Default for KernelToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl KernelToolRegistry {
    pub fn new() -> Self {
        let mut registrations = BTreeMap::new();
        for registration in builtin_tool_registrations() {
            let tool_id = registration.tool_id();
            assert!(
                registrations.insert(tool_id, registration).is_none(),
                "duplicate Kernel tool registration: {tool_id}"
            );
        }
        Self { registrations }
    }

    pub fn descriptor(&self, tool_name: &str) -> Option<&ToolDescriptor> {
        self.registrations
            .get(tool_name)
            .map(|registration| &registration.descriptor)
    }

    pub fn descriptors(&self) -> impl Iterator<Item = &ToolDescriptor> {
        self.registrations
            .values()
            .map(|registration| &registration.descriptor)
    }

    #[doc(hidden)]
    pub fn prompt_guidance(
        &self,
    ) -> impl Iterator<Item = (&ToolDescriptor, &'static [&'static str])> {
        self.registrations
            .values()
            .filter(|registration| !registration.usage_guidelines.is_empty())
            .map(|registration| (&registration.descriptor, registration.usage_guidelines))
    }

    #[doc(hidden)]
    pub fn executor_bindings(&self) -> impl Iterator<Item = (&'static str, KernelToolKind)> + '_ {
        self.registrations
            .values()
            .map(|registration| (registration.tool_id(), registration.kind))
    }

    pub fn canonicalize(
        &self,
        tool_name: &str,
        raw_arguments: Value,
    ) -> Result<KernelCanonicalInvocation, KernelToolCatalogError> {
        let registration = self
            .registrations
            .get(tool_name)
            .ok_or_else(|| KernelToolCatalogError::ToolNotRegistered(tool_name.to_owned()))?;
        if registration.descriptor.availability == ToolAvailability::Blocked {
            return Err(KernelToolCatalogError::ToolBlocked(tool_name.to_owned()));
        }
        canonicalize_invocation(registration.kind, &raw_arguments).map_err(|error| {
            let reason = error.to_string();
            let issues = error.input_issues(&registration.descriptor.input_schema, &raw_arguments);
            KernelToolCatalogError::InvalidArguments {
                tool_name: tool_name.to_owned(),
                reason,
                issues,
            }
        })
    }
}
