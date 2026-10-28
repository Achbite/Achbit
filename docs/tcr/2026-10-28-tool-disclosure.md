# 普通执行中的工具折叠 TCR

用户于 2026-10-28 确认交互预览并明确授权修改源码、构建 Debug 包和简单实测：普通命令在执行过程中默认保持外层工具栏折叠，点击工具栏显示所有条目，再点击条目查看详情；保留单条取消入口，当前审批继续使用既有审批面板。

必要性：`startup-shell-progress.test.mjs` 和 `tool-group-hotfix.test.mjs` 原有断言要求折叠时显示运行命令和实时输出尾部，直接约束了本轮要消除的短命令布局抖动。按用户明确确认的新合同更新这两项既有测试，不新增测试框架、测试专用生产逻辑或扩大矩阵。

旧/新不变量：
- 旧：外层折叠时仍显示运行命令，内层折叠时显示有界输出尾部。
- 新：外层折叠时只有摘要，实时输出到达不改变该结构；手动展开外层后显示条目及单条取消入口，详情继续折叠；再次展开条目后显示完整已有输出。
- 保留：真实 Session 投影/实时进度、活动命令计时、无输出提示、完整输出、不虚构退出码、手动展开状态和取消能力。审批入口和执行事实不变。

验证范围：容器 GUI 既有测试及类型检查；独立 macOS Debug 包聚焦普通执行折叠、两级手动展开、单条取消与审批可见性。结果在实际检查完成后填写。

首次容器 GUI 检查：308 项中 307 项通过，1 项失败来自混合工具测试仍要求折叠时显示 Shell 预览。该断言与用户确认的新合同冲突；将其更新为同组普通工具、Computer Use 和运行命令都遵守外层折叠，且展开列表不展开单项输出，并保留完整输出可访问的断言。

完成结果（2026-10-28）：
- 修改旧合同后，容器聚焦复验 `startup-shell-progress.test.mjs`、`tool-group-hotfix.test.mjs`：27 项通过、0 失败、0 跳过。GUI typecheck 与 manual typecheck 均通过；其余 GUI 测试已在首次检查通过，未扩大至无关 Rust/发布验收。
- 通过 `build.sh -debug --stage package-macos` 生成并启动本次 Debug 0.6.61，沿用现有开发签名。运行包与归档位于 `bin/debug/macos-arm64` 和 `bin/debug/Achbit-Debug-0.6.61-macos-arm64.tar.gz`。
- 独立 Debug Session `session:6408596e61afb9d1d0eb3f593e8c9ab3` 使用真实 DeepSeek。当前命令审批面板可见，工具组保持折叠；仅批准当前固定的打印/sleep 命令后，工具活动为 active、组 expanded=false，命令子项没有自动出现。
- 点击外层后显示全部条目，单项详情仍折叠，且“停止此命令”可用；再点命令后挂载 tool.result 详情，保留已有完整输出。
- 从该命令按钮取消成功。最终 Session 投影为 cancelled / tool_execution_cancelled，运行 3855 ms，stdout 仅 disclosure-start，未打印 disclosure-end；任务 completed，未重试命令。命令在前台窗口之后转为后台 job，取消结果由 Session 的最终进程投影确认。
- Debug 动作回执存在 partial / frame-not-observed（渲染帧观察超时），未重复执行这些动作。后续结构化界面观察完整；运行中折叠截图可读并已实际查看，详情截图为空白，因此不据此宣称完整原生渲染时序或动画验收。
- 本轮资源已停止，stop 返回 cleanupComplete=true；独立状态、凭据副本及工作区已清理。结果、原始回执和保留截图位于 `/private/tmp/achbit-disclosure-debug.ht6vf_ec`。改动保持本地，未提交。
