use achbit_kernel_tools::kernel_internal::{
    KernelCanonicalInvocation, KernelExecutionScope, KernelWorkspaceMode,
};
use achbit_kernel_tools::{KernelToolCatalogError, KernelToolRegistry};
use serde_json::json;

#[test]
fn invalid_arguments_explain_the_rejected_field() {
    let registry = KernelToolRegistry::new();
    for (tool, input, path, rule) in [
        ("bash", json!({}), "$.command", "required"),
        (
            "bash",
            json!({"command":"pwd", "executionMode":"read"}),
            "$.executionMode",
            "additionalProperties",
        ),
        (
            "bash",
            json!({"command":"pwd", "executionScope":"host"}),
            "$.executionScope",
            "additionalProperties",
        ),
        (
            "bash",
            json!({"command":"pwd", "timeout":"slow"}),
            "$.timeout",
            "type",
        ),
        (
            "bash",
            json!({"command":"pwd", "timeout":0}),
            "$.timeout",
            "minimum",
        ),
        (
            "fs.edit",
            json!({"path":"README.md", "edits":[{"oldText":"", "newText":"updated"}]}),
            "$.edits[0].oldText",
            "minLength",
        ),
        (
            "fs.edit",
            json!({"path":"README.md", "edits":[{"oldText":"a", "newText":"b"}], "workspaceMode":"write"}),
            "$.workspaceMode",
            "additionalProperties",
        ),
    ] {
        let KernelToolCatalogError::InvalidArguments { issues, .. } =
            registry.canonicalize(tool, input).unwrap_err()
        else {
            panic!("expected input rejection for {tool}");
        };
        assert!(
            issues
                .iter()
                .any(|issue| issue.path == path && issue.rule == rule),
            "{issues:?}"
        );
    }
    assert!(matches!(
        registry.canonicalize("missing.tool", json!({})),
        Err(KernelToolCatalogError::ToolNotRegistered(_))
    ));
}

#[test]
fn input_rejection_retains_multiple_issues_and_the_original_parse_error() {
    let registry = KernelToolRegistry::new();
    let KernelToolCatalogError::InvalidArguments { reason, issues, .. } = registry
        .canonicalize(
            "bash",
            json!({"command": "pwd", "timeout": "slow", "unexpected": true}),
        )
        .unwrap_err()
    else {
        panic!("expected input rejection");
    };
    assert!(reason.contains("invalid type: string \"slow\""), "{reason}");
    assert!(reason.contains("expected u32"), "{reason}");
    assert!(issues.iter().any(|issue| issue.path == "$.timeout"
        && issue.rule == "type"
        && issue.expected == Some(json!("integer"))));
    assert!(issues
        .iter()
        .any(|issue| issue.path == "$.unexpected" && issue.rule == "additionalProperties"));
}

#[test]
fn semantic_rejection_reports_its_own_field_and_byte_bound() {
    let registry = KernelToolRegistry::new();
    let KernelToolCatalogError::InvalidArguments { issues, .. } = registry
        .canonicalize("bash", json!({"command":"中".repeat(6000)}))
        .unwrap_err()
    else {
        panic!("expected byte-bound rejection");
    };
    assert!(issues.iter().any(|issue| issue.path == "$.command"
        && issue.rule == "maxBytes"
        && issue.expected == Some(json!(16384))));
    let KernelToolCatalogError::InvalidArguments { issues, .. } = registry
        .canonicalize("fs.read", json!({"path":"../outside"}))
        .unwrap_err()
    else {
        panic!("expected path rejection");
    };
    assert!(issues
        .iter()
        .any(|issue| issue.path == "$.path" && issue.rule == "canonicalInput"));
}

#[test]
fn shell_business_input_preserves_the_script_and_leaves_authority_to_kernel() {
    let registry = KernelToolRegistry::new();
    let script = "set -o pipefail\nprintf '%s\\n' 'literal $HOME' | head -1";
    let KernelCanonicalInvocation::ProcessShell {
        command,
        workspace_mode,
        execution_scope,
        timeout,
        terminal,
        request_host_permission,
    } = registry
        .canonicalize("bash", json!({"command":script}))
        .unwrap()
    else {
        panic!("Bash invocation");
    };
    assert_eq!(command, script);
    assert_eq!(workspace_mode, KernelWorkspaceMode::Read);
    assert_eq!(execution_scope, KernelExecutionScope::Workspace);
    assert_eq!(timeout, None);
    assert!(terminal.is_none());
    assert!(request_host_permission.is_none());
    let script =
        "Get-Item -LiteralPath 'D:\\Repo Space\\file.txt'\n& git status -sb\nexit $LASTEXITCODE";
    let KernelCanonicalInvocation::ProcessPowerShell {
        command,
        execution_scope,
        ..
    } = registry
        .canonicalize("powershell", json!({"command":script}))
        .unwrap()
    else {
        panic!("PowerShell invocation");
    };
    assert_eq!(command, script);
    assert_eq!(execution_scope, KernelExecutionScope::Workspace);
}

#[test]
fn shell_authority_fields_are_internal_and_commands_reach_kernel_admission() {
    let registry = KernelToolRegistry::new();
    for tool in ["bash", "powershell"] {
        let descriptor = registry.descriptor(tool).unwrap();
        let requested = registry.canonicalize(tool, json!({
            "command":"pwd", "requestHostPermission":"Access the user-approved external directory",
        })).unwrap().executor_arguments();
        assert_eq!(
            requested["requestHostPermission"],
            "Access the user-approved external directory"
        );
        assert_eq!(
            requested["executionScope"], "workspace",
            "a permission request does not grant authority"
        );
        assert!(registry
            .canonicalize(tool, json!({"command":"pwd", "requestHostPermission":"  "}))
            .is_err());
        for (field, value) in [("workspaceMode", "write"), ("executionScope", "host")] {
            assert!(descriptor.input_schema["properties"].get(field).is_none());
            let mut input = json!({"command": "pwd"});
            input[field] = json!(value);
            let KernelToolCatalogError::InvalidArguments { issues, .. } =
                registry.canonicalize(tool, input).unwrap_err()
            else {
                panic!("model authority field must be rejected");
            };
            assert!(issues
                .iter()
                .any(|issue| issue.path == format!("$.{field}")
                    && issue.rule == "additionalProperties"));
        }
        // Parsing never runs these commands; configured permission policy belongs to Kernel admission.
        for command in ["mkfs.ext4 /dev/example", "format X:", "rm -rf /"] {
            let invocation = registry
                .canonicalize(tool, json!({"command": command}))
                .unwrap();
            let arguments = invocation.executor_arguments();
            assert_eq!(arguments["command"], command);
            assert_eq!(arguments["workspaceMode"], "read");
            assert_eq!(arguments["executionScope"], "workspace");
        }
    }
}

#[test]
fn file_invocations_keep_bounds_and_distinct_unicode_spelling() {
    let registry = KernelToolRegistry::new();
    let KernelCanonicalInvocation::FsRead {
        path,
        start_line,
        max_lines,
        ..
    } = registry
        .canonicalize(
            "fs.read",
            json!({"path":"src/lib.rs","startLine":2,"maxLines":3}),
        )
        .unwrap()
    else {
        panic!("Read invocation");
    };
    assert_eq!(path, "src/lib.rs");
    assert_eq!(start_line, 2);
    assert_eq!(max_lines, 3);
    for expected in ["e\u{301}.txt", "é.txt"] {
        let KernelCanonicalInvocation::FsRead { path, .. } = registry
            .canonicalize("fs.read", json!({"path":expected}))
            .unwrap()
        else {
            panic!("Read invocation");
        };
        assert_eq!(path, expected);
    }
    let KernelCanonicalInvocation::FsWrite { path, content, .. } = registry
        .canonicalize(
            "fs.write",
            json!({"path":"src/generated/main.rs","content":"fn main() {}\n"}),
        )
        .unwrap()
    else {
        panic!("Write invocation");
    };
    assert_eq!(path, "src/generated/main.rs");
    assert_eq!(content, "fn main() {}\n");
}

#[test]
fn shell_deadline_is_optional_and_explicit_values_are_preserved() {
    let registry = KernelToolRegistry::new();
    for tool in ["bash", "powershell"] {
        let omitted = registry
            .canonicalize(tool, json!({"command":"echo ready"}))
            .unwrap()
            .executor_arguments();
        assert!(omitted.get("timeout").is_none());
        let explicit = registry
            .canonicalize(tool, json!({"command":"echo ready", "timeout":3600}))
            .unwrap()
            .executor_arguments();
        assert_eq!(explicit["timeout"], 3600);
        assert!(registry
            .canonicalize(tool, json!({"command":"echo ready", "timeout":0}))
            .is_err());
    }
}
