---
name: achbit-release-audit
description: Review or simplify the requested code and product guidance; documentation cleanup does not imply packaging or publication.
---

# Focused cleanup

Achbit is the current product name. Built-in Skill IDs and product commands use the `achbit-*` prefix.

Confirm the requested scope and effective `AGENTS.md`; preserve existing changes. Analysis returns findings, while authorized cleanup may edit. A documentation task is not a whole-product release audit.

Read only the relevant reference:

- [references/simplification.md](references/simplification.md): evaluate code removal or consolidation.
- [references/product-docs.md](references/product-docs.md): keep user and LLM guidance concise and synchronized.

Trace actual consumers before removing code or a public contract. Prefer deleting duplicate explanations, mirrored state and unused wiring over adding another abstraction. Preserve permissions, original failures and resource lifecycle. Ask before changing supported behavior or an unresolved public interface.

For a whole-repository audit explicitly requested by the user, record actual coverage and exclusions. Otherwise stay with the requested files and directly affected consumers; there is no quota of findings or deletions.

Documentation-only changes use static/link checks and targeted command/schema verification. Code changes follow the project's required tests and test-change rules. Do not add full runtime acceptance because a document discusses it.

Report changes, checks and remaining limits. Compiled-in guidance needs a later runtime rebuild/restart to take effect, but this Skill does not authorize that build, installation, commit or publication.
