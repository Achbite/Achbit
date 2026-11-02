# Managed commands and dependency waiting

Shell, PowerShell, managed commands, long-running tasks, dependency waiting, and cancellation.

## Choose execution and waiting

A normal `bash`, `powershell` or container create/exec call keeps its native result if it finishes within the foreground window (currently two seconds). Otherwise the **same execution** continues and returns `output.job`. An active job is a start receipt, not successful command completion. Its jobId belongs to the current run. The task’s tool selection determines whether the model can call `process`.

For a known long task, use `process` with `action: start`, the available `tool`, and that tool's exact `input`. Choose `workspace` on the outer call. Example: `{"action":"start","tool":"bash","input":{"command":"make build"}}`. Container create and exec are supported when the containers capability is available. A create job completes when its result contains the prepared container; that is different from the container's lifetime.

Continue independent work. At a dependency, call `{"action":"wait","jobId":"<returned jobId>"}`. The call accepts a dependency barrier; final state and output arrive through process updates. The Loop suspends without model polling and resumes on completion, failure, cancellation or new user input. `session` wait also observes active managed commands. Sending a final answer while a job is active does not settle the run.

A yielded ordinary command is still an ordering barrier. Later calls in the same batch may return `notExecuted` with `dependencyPending`; they did not execute. Use the eventual result before reissuing dependent work. Explicit process.start allows independently planned calls to continue.

## One review after prolonged dependency waiting

Shell and container progress stays available in the activity view and execution logs while the model works on something else. The model receives the start receipt, actual tool results, errors and terminal job results. Requesting `status` explicitly also returns the current output.

The first dependency wait without a deadline offers one review after 120 seconds of waiting. A wait with `waitSeconds` uses the chosen deadline instead. When the deadline arrives, Session first checks for completion and new input. If the dependency is still pending, the same Loop receives its job identity, wait timing, last output time and bounded output tails. The model can continue waiting, inspect the job, cancel it, or do other work.

Waiting again without a deadline continues on events after the one review. An explicit subsequent deadline offers another decision at the chosen time. A wait deadline leaves the command running. The execution tool’s optional `timeout` limits the lifetime of the command itself.

## Diagnose and recover

Use concrete evidence. Network failure, proxy configuration, missing credentials, a locked resource, a command waiting for stdin, or a lost executor can require different treatment. The runtime does not infer CPU health or network progress from output silence. Read bounded fullOutput logs instead of rerunning a command for more output.

Within existing task authorization, cancel the job, repair the environment or restart the shell command as needed. `{"action":"cancel","jobId":"<returned jobId>"}` targets that execution. Recheck partial effects before repeating a mutation. Ask only for genuinely missing information or a material choice; routine recovery needs no additional confirmation.

The GUI's **Stop command** cancels one execution without stopping the whole Loop. The task's Stop action cancels the run and cleans its owned jobs. Process cancellation covers the owned command/process group, not an existing user container. Run end cleans temporary test containers under the existing container contract. No command survives the owning run's cleanup by default.
