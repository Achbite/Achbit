# Attribution

DeepCode combines original architecture work with open-source dependencies, public design references, and AI-assisted development tools.

## Original Contributions

Project-specific contributions include:

- A single functional Agent Loop owned by the local Session service.
- A minimal cross-layer protocol, append-only Session journal, and shared projection reducer.
- A controlled Kernel tool catalog with one user-decision boundary immediately before uncovered effects.
- Durable Kernel tool-result records used for exact replay and restart recovery.
- Achbit GUI, CLI, and TUI shells that consume one shared Session projection.
- Plugin-shaped Skill and MCP contributions composed without introducing another Agent Loop.

## Design References

Some architecture, workflow, and UX ideas are informed by public coding-agent tools and editor workflows. These are references only. DeepCode is not an upstream project, fork, official derivative, or affiliated implementation of those tools.

Preferred wording:

- "architecture / workflow / UX reference; not an upstream project"
- "CodeMirror-based code and diff views; limited VS Code-style workspace interoperability"
- "best-effort support and optimization profiles for DeepSeek V4-compatible deployments"
- "independent engineering adaptation and respectful acknowledgement of the DeepSeek team's contributions to open AI research, frontier model development, and the broader pursuit of AGI"

## DeepSeek Acknowledgement

DeepCode includes best-effort support and optimization profiles for DeepSeek V4-compatible deployments. This is an independent engineering adaptation and a respectful acknowledgement of the DeepSeek team's contributions to open AI research, frontier model development, and the broader pursuit of AGI. It does not imply formal affiliation, authorization, sponsorship, endorsement, partnership, or a long-term compatibility guarantee.

## AI-Assisted Development

DeepCode used AI coding tools as development assistance for requirement breakdown, architecture discussion, code generation, review, UI prototyping, and documentation drafting. This does not grant those tools authorship, sponsorship, endorsement, or project ownership.

Relevant tool families may include Claude, ChatGPT, Gemini, and other commercial AI coding agents used during development.
