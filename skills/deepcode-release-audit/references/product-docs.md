# Product guidance editing

Write for the reader's next action, not the history of the implementation.

| Surface | Keep |
| --- | --- |
| Built-in `docs/product/` and Skills | Short purpose, exact interface/example, required conditions, meaningful limits |
| README / installation guide | First use, capabilities, install/update entrypoints and links |
| Public plugin reference | Manifest, slots, signatures, lifecycle and a working example |
| Development material | Build/test procedures and architecture needed for implementation |
| Task receipt | Changes, test results, failures and unfinished work |

## LLM quick-reference style

- Lead with the supported operation or command. Prefer one small table/example to a long process narrative.
- Read current tool schemas, inspect returned state and use result IDs before searching source. Source lookup is for a concrete unresolved fact, not a mandatory preflight.
- Explain a limitation only where it changes the next action. Keep essential permissions and result semantics; remove repeated warnings, historical fixes and internal class tours.
- Separate evidence limits from required checks. A fixture not proving real-model behavior does not make real-model testing mandatory. Debug packaging is not standard-package acceptance.
- Keep detailed contracts where needed for actual extension use. Do not replace a usable interface reference with vague advice or links requiring repository-wide discovery.
- Avoid plans, development logs, test counts, speculative features and automatic release checklists. Read only relevant references; do not chain every Skill.

## Synchronize and check

Preserve existing language conventions and current feature facts. Keep README language variants aligned when they are affected. Reuse existing pages instead of creating another documentation system.

Check changed commands/keys against their entrypoints, relative links/anchors and direct consumers. Built-in resources are registered in `crates/deepcode-kernel-daemon/src/local_agent_product_tools.rs`; package copies are selected by `scripts/package-runtime.py`. Retain registered names unless their public removal is in scope.

Use static/content checks for prose-only edits. Do not modify tests merely to accommodate wording. Embedded docs/Skills change only after the owning runtime is rebuilt and restarted; report source changes separately from the running product. Documentation edits do not authorize packaging or runtime acceptance.
