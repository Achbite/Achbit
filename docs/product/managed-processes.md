# Managed commands and dependency waiting

Shell, PowerShell, managed commands, long-running tasks, dependency waiting, and cancellation.

## Choose execution and waiting

When a task includes `process`, a normal `bash`, `powershell` or container create/exec call keeps its native result if it finishes within the foreground window (currently two seconds). Longer commands continue as the **same execution** and return `output.job` with the current run's job ID. Without the process component, the call waits for the command, cancellation or its timeout and returns the result directly.

For a known long task, use `process` with `action: start`, the available `tool`, and that tool's exact `input`. Choose `workspace` on the outer call. Example: `{"action":"start","tool":"bash","input":{"command":"make build"}}`. Container create and exec are supported when the containers capability is available. A create job completes when its result contains the prepared container; that is different from the container's lifetime. Installed MCP and CLI plugin tools can also start explicitly in the background. The available targets come from the current tool catalog; each job keeps the binding captured at admission while later requests receive catalog updates. Plugin results retain their original content and structured fields.

Each run admits up to four active managed jobs. A full run returns `managed_process_capacity_exceeded` before starting another execution. Completion releases the slot; another Session has its own limit.

Continue independent work. At a dependency, call `{"action":"wait","jobId":"<returned jobId>"}`. The call accepts a dependency barrier; final state and output arrive through process updates. The Loop suspends without model polling and resumes on completion, failure, cancellation or new user input. `session` wait also observes active managed commands. A terminal process event also wakes `agent.wait`, so the parent can consume a finished command while its child agent continues. Sending a final answer while a job is active does not settle the run.

A yielded ordinary command is still an ordering barrier. Later calls in the same batch may return `notExecuted` with `dependencyPending`; they did not execute. Use the eventual result before reissuing dependent work. Explicit process.start allows independently planned calls to continue.

## One review after prolonged dependency waiting

Shell and container progress stays available in the activity view and execution logs while the model works on something else. The model receives the start receipt, actual tool results, errors and terminal job results. Requesting `status` explicitly also returns the current output.

The first dependency wait without a deadline offers one review after 120 seconds of waiting. A wait with `waitSeconds` uses the chosen deadline instead. When the deadline arrives, Session first checks for completion and new input. If the dependency is still pending, the same Loop receives the active job handle and bounded output tails. Terminal notifications and explicit status calls give the command result or error. Wait identifiers, scheduling timestamps and internal execution records stay in the journal. The model can continue waiting, inspect the job, cancel it, or do other work.

Waiting again without a deadline continues on events after the one review. An explicit subsequent deadline offers another decision at the chosen time. A wait deadline leaves the command running. The execution tool’s optional `timeout` limits the lifetime of the command itself.

## Diagnose and recover

Use concrete evidence. Network failure, proxy configuration, missing credentials, a locked resource, a command waiting for stdin, or a lost executor can require different treatment. The runtime does not infer CPU health or network progress from output silence. Read bounded fullOutput logs instead of rerunning a command for more output.

Within existing task authorization, cancel the job, repair the environment or restart the shell command as needed. `{"action":"cancel","jobId":"<returned jobId>"}` targets that execution. Recheck partial effects before repeating a mutation. Ask only for genuinely missing information or a material choice; routine recovery needs no additional confirmation.

The GUI's **Stop command** cancels one execution without stopping the whole Loop. The task's Stop action cancels the run and cleans its owned jobs. Process cancellation covers the owned command/process group, not an existing user container. Run end cleans temporary test containers under the existing container contract. No command survives the owning run's cleanup by default.

MCP tool calls wait for their response, cancellation or server exit. The transport keeps its control/write deadlines and can handle directory updates or other calls while one tool is running. Cancelling an MCP execution reclaims its shared server instance and reports failure to other calls using that instance. A cleanup failure remains an error rather than a confirmed cancellation.
