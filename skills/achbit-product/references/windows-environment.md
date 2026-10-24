# Windows troubleshooting

Use the recorded target, shell dialect and original error before changing anything.

| Symptom | Next check |
| --- | --- |
| Command not found | Prepared PATH and selected shell; this is not an inventory of installed software |
| PowerShell syntax failure | PowerShell 5.1 has no `&&` / `||`; use valid syntax and preserve native `$LASTEXITCODE` |
| `powershell_unavailable` | Selected executable/path; choose or install a shell only with authorization |
| Docker connection failure | Socket/access and actual daemon error; changing shells does not start Docker |
| `*_workspace_sandbox_unavailable` | `workspaceSandbox.reason`; Settings → Execution environment → Check Windows support |
| Linux/WSL sandbox failure | Bubblewrap and namespace support; WSL1 is not supported |
| Missing GUI output | Read the matching tool result before concluding nothing executed |

Automatic native selection prefers PowerShell 7, then Windows PowerShell. Explicit choices do not fall back. Git Bash is opt-in; `System32/bash.exe` is a WSL launcher. For a project requiring Linux, select an explicit WSL distribution and installed Linux Kernel rather than translating commands by guesswork.

New runs capture configuration; explicit environment refresh updates Host paths. Do not reinstall the product, edit Session databases, relax permissions or switch to Host execution as a generic remedy. See `execution-environments.md` in `productDocsPath` for configuration.
