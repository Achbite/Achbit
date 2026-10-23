use crate::invocation_types::KernelToolKind;
use serde_json::Value;

pub(super) fn provider_schema_for_tool(tool: KernelToolKind) -> Value {
    let mut schema = match tool {
        KernelToolKind::FsRead => serde_json::json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "UTF-8 text file path, relative to the workspace or absolute. External files require permission."
                },
                "startByte": { "type": "integer", "minimum": 0, "maximum": 9007199254740991u64, "description": "Resume at nextByte from the previous read, including within long lines. Takes precedence over startLine." },
                "startLine": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": u32::MAX,
                    "description": "First one-based line to return. Defaults to 1."
                },
                "maxLines": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 5000,
                    "description": "Maximum number of lines to return. Defaults to 2000."
                },
                "maxBytes": {
                    "type": "integer",
                    "minimum": 1024,
                    "maximum": 1048576,
                    "description": "Maximum UTF-8 output bytes. Defaults to 262144."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsWrite => serde_json::json!({
            "type": "object",
            "required": ["path", "content"],
            "properties": {
                "path": {
                    "type": "string",
                    "minLength": 1,
                    "description": "File path, relative to the workspace or absolute. External files require permission. Missing parents are created."
                },
                "content": { "type": "string" },
                "executable": {
                    "type": "boolean",
                    "description": "Optional executable state. New files default to false; existing files preserve their mode when omitted."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsEdit => serde_json::json!({
            "type": "object",
            "required": ["path", "edits"],
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "edits": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 128,
                    "description": "Non-overlapping replacements matched against the original file and applied atomically.",
                    "items": {
                        "type": "object",
                        "required": ["oldText", "newText"],
                        "properties": {
                            "oldText": { "type": "string", "minLength": 1, "description": "Copy a small, exact, unique region from the original file. Preserve whitespace. Include only enough context to distinguish this occurrence; do not copy large unchanged regions." },
                            "newText": { "type": "string", "description": "Exact replacement, including any boundary newline that should remain. Empty text deletes the region. After editing shell syntax, bash -n each changed script before running it." }
                        },
                        "additionalProperties": false
                    }
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::FsDelete => serde_json::json!({
            "type": "object",
            "required": ["path", "targetKind"],
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "targetKind": {
                    "type": "string",
                    "enum": ["file", "directoryTree"],
                    "description": "Required exact deletion target kind."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::ProcessPowerShell => {
            let mut schema = provider_schema_for_tool(KernelToolKind::ProcessShell);
            schema["properties"]["command"]["description"] = serde_json::json!("PowerShell script with newlines. Use literal single-quoted strings or here-strings. Native programs expose $LASTEXITCODE; preserve it explicitly when later commands print diagnostics. PowerShell 5.1 does not support && or ||.");
            schema
        }
        KernelToolKind::ProcessShell => serde_json::json!({
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 16384,
                    "description": "Bash script. Each call starts at the selected workspace root. In the sandbox, HOME is the session home directory; TMPDIR is removed after this call. Use an explicit template for temporary files, e.g. mktemp -d \"$TMPDIR/build.XXXXXX\". Store persistent output in the session workspace. Preserve the target command exit status."
                },
                "requestNetworkPermission": {
                    "type": "string", "minLength": 1, "maxLength": 1024,
                    "description": "Reason to enable network in this sandbox. File permissions stay unchanged. Omit after the environment has an active network grant."
                },
                "requestHostPermission": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1024,
                    "description": "Request Host execution with this reason. Use requestFileAccess for additional files while keeping the sandbox."
                },
                "requestFileAccess": {
                    "type": "object",
                    "description": "Request extra absolute paths outside the project. Project edits/deletions use file tools; test/output directory writes use Plan writablePaths.",
                    "properties": {
                        "reason": { "type": "string", "minLength": 1, "maxLength": 1024, "description": "Explain why this external access is needed. Project scope changes use Plan instead." },
                        "read": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                        "write": { "type": "array", "items": { "type": "string", "minLength": 1 } }
                    },
                    "additionalProperties": false
                },
                "timeout": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 4294967295u64,
                    "description": "Optional total runtime limit in seconds. Omit for no time limit; cancellation remains available."
                },
                "terminal": {
                    "type": "object",
                    "required": ["stdin"],
                    "properties": {
                        "stdin": {
                            "type": "string",
                            "maxLength": 65536,
                            "description": "Exact bounded input written once to a temporary PTY. Include commands that terminate the interactive program and shell."
                        }
                    },
                    "additionalProperties": false,
                    "description": "Optional one-call PTY. When omitted, stdin is closed. No persistent terminal session is created."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::WebSearch => serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": { "type": "string", "minLength": 1 },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10,
                    "description": "Maximum result count. Defaults to 5."
                }
            },
            "additionalProperties": false
        }),
        KernelToolKind::WebFetch => serde_json::json!({
            "type": "object",
            "required": ["url"],
            "properties": {
                "url": {
                    "type": "string",
                    "minLength": 1,
                    "description": "HTTP or HTTPS URL without user-info."
                },
                "maxBytes": {
                    "type": "integer",
                    "minimum": 1024,
                    "maximum": 262144,
                    "description": "Maximum response body bytes. Defaults to 98304."
                }
            },
            "additionalProperties": false
        }),
    };
    if matches!(
        tool,
        KernelToolKind::FsRead
            | KernelToolKind::FsWrite
            | KernelToolKind::FsEdit
            | KernelToolKind::FsDelete
    ) {
        schema["properties"]["requestFileAccess"] =
            provider_schema_for_tool(KernelToolKind::ProcessShell)["properties"]
                ["requestFileAccess"]
                .clone();
    }
    schema
}
