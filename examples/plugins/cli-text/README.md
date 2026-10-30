# Local CLI tool template

Choose **Settings → Plugins → Add** and select this directory. The interface reads the name, purpose, and entrypoint from `achbit-tool.json`.

After registration and enablement, the Agent can discover this text-statistics tool through `plugin.search` and load it through `plugin.activate`. Users can also select it explicitly in the composer. Registration alone does not add it to every task. Activation supplies tools and guidance to the next model request in the current run.

Search matches the manifest's name and purpose plus tool names and descriptions, so describe the work the plugin performs. Use short keywords; every whitespace-separated word must match the same plugin. To browse without knowing a name, omit query and continue with the returned nextOffset.

The program reads one JSON object `{name, arguments, context}` from stdin and writes one JSON result to stdout. Failures return `{error:{code,message}}`; diagnostics go to stderr.

`command` is an available interpreter, `entry` is a single-file build output within the directory, and `args` follow that entrypoint. Execution does not concatenate a shell command. Tools needing third-party libraries must bundle their own code into one entrypoint and use the configured interpreter environment. Other static files are not automatically copied into the invocation directory.

Selected entrypoint content is captured during request preparation. A saved replacement takes effect at the next request; pending approvals and in-flight calls retain their original content. Calls use the existing Kernel execution path, and local external programs remain subject to external execution permissions. Each invocation has its own process, reclaimed on timeout or cancellation.
