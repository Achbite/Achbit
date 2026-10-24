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
            "Apply exact, non-overlapping replacements atomically to one workspace text file. Match each oldText uniquely against the original file using a small anchor. Combine disjoint changes in one call; replacements all use the original content, not earlier edits in the call.",
            &[],
        ),
        KernelToolKind::FsRead => (
            "Read bounded UTF-8 text from a workspace file. The content field preserves source text and whitespace. Check truncation and returned ranges before reading more. For PDFs or binary files, use a reader suited to that format.",
            &[
                "Use for a bounded read of a known text file with an exact file reference. Use Shell for search or combined inspection.",
                "Use startLine and maxLines for a line range; startByte and maxBytes for byte bounds."
            ],
        ),
        KernelToolKind::FsWrite => (
            "Create or replace one workspace file and any missing parent directories.",
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
            "Run PowerShell from the bound workspace root. Project files are read-only except approved output directories and session drafts. Commands over the foreground window return a running job; use process with action=wait and jobId at a dependency. Optional terminal is a one-call PTY; otherwise stdin is closed.",
            &[
                "Use PowerShell syntax and preserve the command exit status. For platform details or environment errors, read execution-environments.md in productDocsPath.",
                "Use Shell for searching files or inspecting several sources in one command."
            ],
        ),
        KernelToolKind::ProcessShell => (
            "Run Bash from the bound workspace root. Project files are read-only except approved output directories and session drafts. Commands over the foreground window return a running job; use process with action=wait and jobId at a dependency. Optional terminal is a one-call PTY; otherwise stdin is closed.",
            &[
                "Use the project's build/test entrypoints and preserve exit status. Use file tools to edit project files; read execution-environments.md in productDocsPath for scope and environment errors.",
                "Inspect returned fullOutput paths when output is truncated."
            ],
        ),
    }
}
