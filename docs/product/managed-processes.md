# Managed commands and dependency waiting

Shell, PowerShell, long-running tasks, 托管任务, 长命令, 等待, 卡住, 取消.

## Choose execution and waiting

A normal `bash`, `powershell` or container create/exec call keeps its native result if it finishes within the foreground window (currently two seconds). Otherwise the **same execution** continues and returns `output.job`. An active job is a start receipt, not successful command completion. Its jobId belongs to the current run. `process` is always available; the Processes plugin is an optional guide.

For a known long task, use `process` with `action: start`, the available `tool`, and that tool's exact `input`. Choose `workspace` on the outer call. Example: `{"action":"start","tool":"bash","input":{"command":"make build"}}`. Container create and exec are supported when the containers capability is available. A create job completes when its result contains the prepared container; that is different from the container's lifetime.

Continue independent work. At a dependency, call `{"action":"wait","jobId":"<returned jobId>"}`. The call accepts a dependency barrier; final state and output arrive through process updates. The Loop suspends without model polling and resumes on completion, failure, cancellation or new user input. `session` wait also observes active managed commands. Sending a final answer while a job is active does not settle the run.

A yielded ordinary command is still an ordering barrier. Later calls in the same batch may return `notExecuted` with `dependencyPending`; they did not execute. Use the eventual result before reissuing dependent work. Explicit process.start allows independently planned calls to continue.

## One review after prolonged dependency waiting

The automatic review starts 120 seconds after the Loop actually waits on its dependencies. Background runtime during independent work does not count. Output/revision refreshes do not restart this timer. The runtime rechecks completion before delivering a review to the existing Loop.

Review the job state, start/output timestamps, output tail and original errors. Silence or elapsed time alone does not prove a hang. If normal, call `process` with `action: "wait"` and the same `jobId` again: this logical wait has consumed its one automatic review and will wait for events without another timed model request. Cancelling and replacing a job during diagnosis retains this allowance. This is not a process timeout.

`status` is for a deliberate inspection, not periodic monitoring. `waitSeconds`, when explicitly needed for a task deadline, bounds that wait without killing the command; do not repeat it as a polling loop. Omit `timeout` for no execution deadline; explicit execution timeout still applies to total process runtime.

## Diagnose and recover

Use concrete evidence. Network failure, proxy configuration, missing credentials, a locked resource, a command waiting for stdin, or a lost executor can require different treatment. The runtime does not infer CPU health or network progress from output silence. Read bounded fullOutput logs instead of rerunning a command for more output.

Within existing task authorization, cancel the job, repair the environment or restart the shell command as needed. `{"action":"cancel","jobId":"<returned jobId>"}` targets that execution. Recheck partial effects before repeating a mutation. Ask only for genuinely missing information or a material choice; routine recovery needs no additional confirmation.

The GUI's **Stop command / 停止此命令** cancels one execution without stopping the whole Loop. The task's Stop action cancels the run and cleans its owned jobs. Process cancellation covers the owned command/process group, not an existing user container. Run end cleans temporary test containers under the existing container contract. No command survives the owning run's cleanup by default.
