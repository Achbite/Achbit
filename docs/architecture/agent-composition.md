# Agent composition and execution authority

An Agent type is a composition of installed components. `analysis` and `collaboration` are the two default templates; they supply defaults for messaging, continuation and delegation. They are not an exhaustive type enumeration. The model can give a child any task-specific name and select its model, reasoning effort, Loop driver, context, compaction, controls, capabilities, policy restrictions and workspace Sandbox. `agent` with `action: "models"` returns the installed choices and operation schemas. Full model/context configuration is enabled by default; an explicit `agent.subagents.allowFullConfiguration: false` retains the restricted choices.

Root and child Sessions persist the same `AgentRecipe` in `session.created`. The projection exposes that recipe, and reopening a Session restores the selected implementations. `agentContext` carries lineage and collaboration capabilities. Historical `agentContext.configuration` remains readable; new Sessions store configuration only in the recipe. No database migration or event-version change is required for these additive optional fields.

## CLI

Create a Session with `deepcode-cli -C /path/to/project --recipe /path/to/recipe.json ask "task"`. `--recipe` also works with `chat`; it cannot replace an existing Session's recipe through `--session`. The existing model setting commands remain available. An optional `profileId` selects a configured model profile; an optional `reasoningEffort` must be supported by that profile.

```json
{
  "runner": { "id": "standard" },
  "configuration": {
    "context": { "id": "journal" },
    "compaction": { "id": "summary", "parameters": { "pressureRatio": 0.8 } },
    "controls": { "id": "standard", "parameters": { "optionalTools": [] } }
  },
  "permissionPolicy": { "id": "workspace-only" },
  "workspaceSandbox": { "backendId": "platform-default" },
  "permissions": { "agent.permissions.workspaceMutation": "plan" }
}
```

The model-facing `spawn` operation accepts `runner`, `context`, `loop.controls`, `loop.compaction`, `permissionPolicy` and `workspaceSandbox` in addition to the existing model, capability and permission overrides. Omitting `preset` uses the analysis defaults and still permits custom composition. Custom executable code must first be registered by the Host; neither model input nor a recipe imports modules or executable paths.

## Loop extension contract

`AgentLoopRegistry` contributions provide `id`, description, parameter schema, validation, and a factory returning `run` and optional `dispose`. A driver receives the same `LoopSnapshot`, `LoopCommand`, `AgentLoopDeps` and cancellation signal as `runAgentLoop`. It must use the supplied commit path for admitted journal events, the Provider port for model calls and the Kernel port for effects. The Actor continues to own serialization, recovery, cancellation, process cleanup and runtime release. It disposes the driver after active execution ends, including initialization rollback.

`SessionConfigurationRegistry` separately registers context, compaction and control implementations. Both registries are passed to `createSessionService` by a trusted `SessionServiceFactory`, including factories loaded through the existing `DEEPCODE_SESSION_SERVICE_MODULE` startup option. Components are validated before Session creation, and unavailable components fail on restoration without silently selecting another implementation.

This creates a boundary for future specialized loops and cluster transports. It does not implement distributed scheduling, remote authorization, worker attestation or training. Those additions must preserve journal identities, cancellation and Kernel authority rather than treating a new Loop as a grant.

## Parent authority and automatic Kernel admission

A child inherits the parent's granted mutation scope, not authority to invent a new one. The Kernel resolves Plan authority through the **current active delegation task**, including nested delegation, and keeps the original parent confirmation identity. Continuing a child follows the new delegating run. Revoked/revised Plans and completed delegations cannot be reused from old child events. A child may narrow a Plan; an uncovered path still requires the ordinary Plan decision.

The creating Agent sends only its requested restrictions. The Kernel validates them against the parent's current permission model and persists the admitted recipe; the Agent does not copy a parent permission projection or issue a second permission-setting command after creation. These settings do not copy arbitrary approval receipts, private scratch directories, or GUI authority.

`KernelPermissionModel` owns the effective permission tree. A permission-changing journal transaction stages the affected subtree, compiles its policies, commits the durable facts and publishes the model under the same writer lock before acknowledging success. A failed transaction publishes neither the facts nor the model. Parent changes therefore reach already-running children and grandchildren without a child command, a new tool call or ancestry polling. Tool admission reads the compiled model and applies the immutable recipe constraints. Startup reconstructs the model once from the journal; deleted parents leave retained descendants restricted, and historical automatic grants remain readable but unusable.

Plan publication asks the Kernel's `planAdmission` port for `user`, `agent` or `parent` admission. Loop code does not decide this from the original run permission snapshot. Inherited Plans retain their original confirmation identity, including when automatic confirmation is enabled. The journal rejects an independent automatic grant when a parent Plan supplies the authority. Tightening mutation permission revokes outstanding automatic Plan grants; execution-policy changes revoke old approvals and invalidate pending automatic reviews before their results arrive. A late review remains evidence, not a new grant. Actual Plan coverage, identity, protected-resource and execution checks remain Kernel responsibilities on every effect.

The public projection publishes current effective permissions from the same Kernel model. A child's own journal revision is not a version for its inherited permissions, and GUI consumers accept producer updates at the same journal revision. Historical run snapshots remain execution records, not an authority source.

Shell isolation and file mutations have different owners:

* The Sandbox executes a Kernel-admitted Shell command with its granted file/network scope. Project sources remain read-only to workspace Shell; approved output directories retain their existing behavior.
* File tools mutate project files through Kernel admission, including Plan coverage, protected-resource checks, mutation locks and execution records. A Sandbox selection never authorizes a file write.

`local-standard` preserves ordinary Kernel gates and accepts `allowHostExecution` / `allowExternalTools` restrictions. `workspace-only` prohibits both routes; it does not mean all workspace files become writable. The restriction survives later permission-setting updates. A child cannot relax its parent's policy constraints.

## Publication ownership

`KernelAuthorityModel` publishes Plan, delegation, approval, review-proof, execution-scope and file-grant indexes in the journal transaction alongside permissions. Task completion, Plan invalidation, run ending, explicit revocation, conversation revision and archive deletion update the indexes at their producer boundary. Admission verifies identities and scope against these indexes; it does not replay history or traverse parents on every call.

Journal write responses carry permission publications for the affected subtree. `HttpCommandJournal` delivers them before acknowledging the write to Session, ordering delayed responses by the producer revision. Actor guidance and approval waits consume this published view; a parent's change need not produce a child permission event or advance the child's journal revision.

An Actor publishes committed facts directly into its snapshot before acknowledgement and wakeups. Command journal commits return both the reply and committed events. Initialization and recovery after a failed write are the only history-read paths; normal snapshot reads consume the published projection. An explicit conversation revision rebuilds its projection during the write.

Settings publication serializes persistence and delivery without holding the run-preparation lock while waiting for Session. Locks and values are prepared before persistence, so failed storage writes publish no runtime change. The settings file retains the desired state if Session delivery fails; the error explicitly reports pending publication. Identical PATCH retries redeliver the value, and each Session service bootstraps it once before Actor recovery. Agents do not poll settings to compensate for a failed publisher.

## Sandbox selection and coverage

`platform-default` selects the execution target's native backend: `windows-lpac`, `sandbox-exec`, or `bubblewrap` (including WSL). An explicit backend must match that target and pass its support probe. `requireIsolatedProcesses: true` also requires usable isolation and prohibits Host/external process routes. Unsupported selections fail without a Host fallback. Ordinary default Sessions can still use Kernel file tools when workspace Shell is unavailable.

The runtime `SandboxBackend` interface owns the complete launch/wait/cancel/cleanup operation, preserving Windows LPAC token and Job Object handling. Trusted runtime code can inject a `SandboxBackendRegistry` through `KernelExecutorConfig`; the product recipe currently exposes the native backends. WSL carries the selected backend identity in the prepared file scope to its worker.

Current coverage is explicitly `workspaceShell`. CLI/MCP programs and container tools are separate Host routes, not automatically isolated by selecting a workspace backend. Restricted recipes reject selected MCP/Computer Use programs before process initialization, and Kernel admission rejects prohibited Host or external effects. The run environment records the resolved backend and policy constraints.

## Verification

`scripts/tests/agent-composition-cli.py` uses the real CLI, daemon, Session bridge and Kernel with a local fixture Provider. It registers a custom Loop driver at Host startup, composes a child without defining another preset, verifies inherited parent Plan writes and denied out-of-scope/Host calls, restarts the daemon to restore the root recipe, and checks that a prohibited MCP process never starts. It also tightens a parent while its child is active: the existing automatic Plan stops granting writes, a new Plan waits for explicit user confirmation, and the restriction survives restart and continuation without duplicate child permission commands. The CLI also injects settings write/delivery failures, verifies identical-value retry and restart recovery, inspects child Provider permission guidance, and records journal reads to exclude Actor refresh loops. Session tests additionally cover driver disposal, invalid selections, lost commit acknowledgements and permission wakeups without a journal revision; Kernel tests cover atomic rollback, nested propagation, pending reviews and orphaned archive restoration. Actual platform isolation still requires running the workspace Shell suite on a supported host. The broader ownership audit, resolved A1–A4 findings and retained boundaries are recorded in [producer-consumer-audit.md](producer-consumer-audit.md).
