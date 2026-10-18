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
                "Use this to inspect the contents of a known workspace text file instead of shell commands such as cat or sed.",
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
            "Run a PowerShell script in the selected Windows environment. Kernel applies available filesystem permissions: project files are read-only; approved test/output directories and session drafts are writable. The result preserves the actual exit status and output.",
            &[
                "Each call starts in the bound workspace root with no profile and UTF-8 output. Use PowerShell syntax; Windows PowerShell 5.1 does not support && or ||. Preserve $LASTEXITCODE for native commands.",
                "Use the project's required build/test entrypoints. Report errors precisely: distinguish the current PATH, access permission and connection failure from software availability or service state.",
                "Use file tools to edit or delete project files. Declare test/output directories in Plan writablePaths. Kernel owns temporary resources for each call; keep files needed by later calls in workspace paths."
            ],
        ),
        KernelToolKind::ProcessShell => (
            "Run a Bash script from the bound workspace root. Kernel applies the available filesystem permissions: project files are read-only; approved test/output directories and session drafts are writable. Commands can fail at the sandbox boundary; the result preserves their exit status and output. Optional terminal input uses a one-call PTY; otherwise stdin is closed.",
            &[
                "Use cd for subdirectories and the project's required build/test entrypoints. Preserve the exit status being checked, including pipeline failures. Use fs.read for known UTF-8 workspace files.",
                "Report errors precisely: distinguish the current PATH, access permission and connection failure from software availability or service state.",
                "Use file tools to edit or delete project files. Declare test/output directories in Plan writablePaths. Kernel owns temporary resources for each call; keep files needed by later calls in workspace paths.",
                "Output is limited to the last 2000 lines or 50 KiB. When truncated, inspect bounded sections of the returned fullOutput log paths instead of repeating the command."
            ],
        ),
    }
}
