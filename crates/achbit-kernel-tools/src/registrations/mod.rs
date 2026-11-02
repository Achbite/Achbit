mod schema;

use self::schema::provider_schema_for_tool;
use crate::invocation_types::KernelToolKind;
use crate::types::{ToolAvailability, ToolDescriptor, ToolEffectClass, ToolEffectScope};

#[derive(Debug, Clone)]
pub(crate) struct KernelToolRegistration {
    pub(crate) descriptor: ToolDescriptor,
    pub(crate) kind: KernelToolKind,
    pub(crate) usage_guidelines: &'static [&'static str],
}

impl KernelToolRegistration {
    pub(crate) fn tool_id(&self) -> &'static str {
        self.kind.as_str()
    }
}

#[derive(Clone, Copy)]
struct ToolSpec {
    tool: KernelToolKind,
    effect_class: ToolEffectClass,
    effect_scope: ToolEffectScope,
}

const fn tool(
    tool: KernelToolKind,
    effect_class: ToolEffectClass,
    effect_scope: ToolEffectScope,
) -> ToolSpec {
    ToolSpec {
        tool,
        effect_class,
        effect_scope,
    }
}

pub(crate) fn builtin_tool_registrations() -> Vec<KernelToolRegistration> {
    use KernelToolKind as Tool;
    use ToolEffectClass::{Mutation, Read};
    use ToolEffectScope::{NetworkRead, Process, WorkspaceRead, WorkspaceWrite};

    [
        tool(Tool::ProcessPowerShell, Mutation, Process),
        tool(Tool::FsRead, Read, WorkspaceRead),
        tool(Tool::FsWrite, Mutation, WorkspaceWrite),
        tool(Tool::FsEdit, Mutation, WorkspaceWrite),
        tool(Tool::FsDelete, Mutation, WorkspaceWrite),
        tool(Tool::WebSearch, Read, NetworkRead),
        tool(Tool::WebFetch, Read, NetworkRead),
        tool(Tool::ProcessShell, Mutation, Process),
    ]
    .into_iter()
    .map(register_tool)
    .collect()
}

fn register_tool(spec: ToolSpec) -> KernelToolRegistration {
    let tool_id = spec.tool.as_str();
    let (description, usage_guidelines) = tool_guidance(spec.tool);
    KernelToolRegistration {
        descriptor: ToolDescriptor {
            name: tool_id.to_owned(),
            description: description.to_owned(),
            input_schema: provider_schema_for_tool(spec.tool),
            effect_class: spec.effect_class,
            effect_scope: spec.effect_scope,
            availability: ToolAvailability::Callable,
        },
        kind: spec.tool,
        usage_guidelines,
    }
}

fn tool_guidance(tool: KernelToolKind) -> (&'static str, &'static [&'static str]) {
    match tool {
        KernelToolKind::FsDelete => (
            "Delete one explicitly named workspace file or directory tree.",
            &[],
        ),
        KernelToolKind::FsEdit => (
            "Make targeted changes to one text file. All replacements match the original file and apply atomically.",
            &[],
        ),
        KernelToolKind::FsRead => (
            "Read a UTF-8 file or list a directory's immediate entries in name order. Use path='.' for the workspace root.",
            &[
                "Continue a partial file with startByte=nextByte, or a directory with startLine=nextStartLine."
            ],
        ),
        KernelToolKind::FsWrite => (
            "Write the complete contents of a new or existing file. Missing parent directories are created.",
            &[],
        ),
        KernelToolKind::WebFetch => (
            "Read bounded text from a known HTTP or HTTPS URL.",
            &[
                "Read URLs supplied by the user or returned by search."
            ],
        ),
        KernelToolKind::WebSearch => (
            "Search the web by keyword and return sources.",
            &[
                "Cite returned sources and report search errors."
            ],
        ),
        KernelToolKind::ProcessPowerShell => (
            "Run PowerShell from the selected workspace. List, search and inspect files here. Project writes are limited to authorized output directories. The session working directory is writable. Longer commands return a running job.",
            &["Preserve the target program's exit code when printing diagnostics."],
        ),
        KernelToolKind::ProcessShell => (
            "Run Bash from the selected workspace. Use ls, rg or find to discover files. Project writes are limited to authorized output directories. The session working directory is writable. Longer commands return a running job.",
            &["Preserve the target command's exit status through pipelines and trailing diagnostics."],
        ),
    }
}
