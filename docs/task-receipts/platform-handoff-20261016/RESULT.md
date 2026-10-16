# Windows / macOS 功能缺口接管与验收记录

日期：2026-10-16。执行主机：本机 Windows；开发容器：本机 WSL 的 deepcode-dev，/workspace 绑定 E:\Dev-Agent\deepagent。

本机 Achbite-dev 已由 0d67a526 快进到 origin/Achbite-dev 的 52554c05b8de00223e2ddad88d5cb27a604a7bb0，共同步 7 个提交。同步前工作区干净；没有回退远端、重置历史或覆盖用户改动。本次 Windows GUI、Chrome、GUI → SSH → WSL 容器验收已完成。用户最新指令为“分组提交即可”，因此仅分组提交到本地 Achbite-dev，不推送远端，也不发布安装包。

接管来源：01a1433d-9a74-753a-bd72-aeb241ae5020。源任务最后一轮已获“同步解决这些缺口”授权，并确认保留 macOS 当前支持范围。该轮中断，补丁未进入远端。应用无法直接迁移该任务；本次读取并保存补丁，先写 TCR，再在相同源码基线上复核、接入与修正。云端测试未冒充本机验收。

## 代码核对及实现

| 能力 | 同步基线中的缺口 | 本次状态 |
| --- | --- | --- |
| Windows 内置浏览器实时预览 | 前端仅开放 Mac，原生预览缺 Windows 实现 | 接入 WebView2 CapturePreview、有界 JPEG 缩略图，串行化截图并校验页面、任务和几何身份；复用现有预览与停止链路 |
| Windows UIA setValue | 写入后直接报 dispatched，未读回同一控件 | 单次写入后有界读回，沿用 valueVerification/actionError；不匹配、控件关闭或读回失败保留派发事实，不重复写入 |
| Windows Chrome | 运行资源已打包，内置 MCP 注册却仅在 macOS 启用 | 注册 Windows 贡献，选择随包 node.exe，保留现有启用、权限与回收路径 |
| Windows 作为 SSH 远端 | 启动命令固定为 POSIX exec/env | SshTarget 新增可选 remoteShell=posix|windows，GUI 和 CLI 同步；旧配置继续 POSIX，Windows 走编码 PowerShell 启动原有 gui-attach |
| Windows TUI 字体 | 专用窗口与 /font 仅有 macOS 适配 | 专用经典控制台、共享 GUI 字体设置、四套内置字体和系统字体；--in-place 保留当前终端。字体只临时加载，实际名称会回读确认 |
| macOS 助手故障恢复 | 已失败连接在助手退出后仍被缓存 | 仅确认同一助手进程退出后才允许后续调用重建；保留一次性退出事件的证明，不重放失败输入 |
| macOS 最低版本提示 | 主程序 12+ 与桌面助手 15.2+ 边界缺明确提示 | 保留原范围，在尝试加载桌面助手前检查系统产品版本并返回清楚原因 |

Windows 桌面 WGC 持续采集、操作位置指针、按任务释放链路本来已经存在，本次没有重新实现或替换。平台专属能力继续保留：macOS 系统共享/辅助功能授权，Windows WGC/UIA、完整性级别限制，Windows LPAC 与 macOS sandbox-exec。

本次是围绕源任务所列能力及直接调用方的代码复核，不是全仓逐函数审计。

## 本机验收额外发现并修复

1. PowerShell New-Object 会首次自动加载模块，向 SSH stderr 输出 CLIXML 进度。改成直接 .NET 构造后，真实 cmd.exe 和 PowerShell 下的 UTF-8 输入输出及特殊路径均通过。
2. Windows 接受空绑定地址，导致既有 GUI 测试失败。将原本调用方已有的 loopback 约束移到端口选择的唯一入口，不放宽测试，也不新增重复校验。
3. Rust Command 继承标准句柄使直接启动的 conhost 进入 ConPTY 模式，独立控制台未启动。改用无句柄继承的原生进程创建，保留参数转义、环境和进程句柄释放。
4. 中文代码页下，系统把请求字体替换为新宋体。只对 DeepCode 自己的控制台设置 UTF-8 输出代码页后，四套内置字体均被实际选中。用户其他终端和全局字体配置不变。

控制台启动判断参考微软的 [入口实现](https://github.com/microsoft/terminal/blob/main/src/host/exe/exemain.cpp) 与 [ConPTY 句柄判断](https://github.com/microsoft/terminal/blob/main/src/host/ConsoleArguments.cpp)。结论另有本机失败与修复后回执支持。

## 合同与范围

- 新增 SSH 连接配置 remoteShell；不指定时保持 POSIX。旧版程序不认识此字段，因此新写出的 Windows 配置需要支持该字段的新客户端。
- gui-attach 握手、Session/Agent Runtime schema、Kernel syscall、权限和取消协议未扩展。
- Kernel 改动仅为已有 Chrome 贡献的 Windows 注册与已有 setValue 结果说明。
- setValue 复用现有 actionError/valueVerification 输出语义；macOS 改用共享的有界读回实现。
- macOS 主程序 12+、桌面控制 15.2+；未扩展旧系统桌面实现。

## 本机验证

| 检查 | 结果 |
| --- | --- |
| bash ./test.sh required | 最终串行通过：Rust 工作区、19 项构建发布、5 项 GUI 资源发布、TUI JS 16、Session 226、GUI 182、正式与手工预览类型检查 |
| 容器 Git diff 检查 | 因宿主 Git 元数据不可用跳过；本机 git diff --check 已补测通过 |
| Windows Host 原生测试 | 21 通过，含真实 Shell 标准流、显式启用的助手停止与替换测试 |
| Windows Computer Use 原生测试 | 常规 18 通过；显式启用的 WGC 实窗测试 1 通过 |
| Windows CLI / TUI 原生测试 | CLI 27、TUI 48 通过；TUI 包含显式启用的专用控制台字体测试 |
| Windows 原生 GUI 测试 | 10 通过，包含缩略图编码、页面身份、控制提示与监听地址 |
| Windows Kernel 编译 | cargo check --target x86_64-pc-windows-gnu -p deepcode-kernel-daemon --tests 通过 |
| macOS Host 编译 | cargo check -p deepcode-host-connection --tests --target aarch64-apple-darwin 通过 |
| 字体构建 | 仓库规定 fonttools 4.67.0，重建终端 ZIP，保留字形、字宽与许可，Mac PostScript 名称不变 |

Windows 原生测试合计 125 项通过。WGC 实窗回执验证了遮挡时继续刷新、窗口缩放、指针保留、精确任务释放及辅助进程 EOF 清理。TUI 真实控制台回执确认四套内置字体和 Consolas；任务独立验收程序另验证中文、空格、引号与尾随反斜杠参数。

首轮 SSH CLIXML、GUI 空地址、TUI 启动及字体替换失败均保留在 .build-cache/platform-handoff-20261016/，没有用旧回执代替本次成功结果。

## 2026-10-16 Windows 完整包及真实模型续验

本轮已在本机 WSL 开发容器构建完整 Windows 和 Linux 包，位于 `.build-cache/platform-handoff-20261016/runtime/`。未替换日常 `bin/win64`。Windows GUI 实际加载该目录中的 DeepCode-GUI.exe；构建时源码为 52554c05 加本次未提交改动。容器无法读取宿主 Git 元数据，BUILDINFO 的 sourceCommit 保持 unknown，没有伪造身份。

Windows GUI → 真实 DeepSeek → Computer Use → 专用原生测试窗口的单窗口验收通过。会话为 `session:e46dc272a6b4fdf86030c7146d108a19`，Provider 用量记录证实 16 次请求均来自 deepseek-api / deepseek-flash。通过真实 GUI 提交任务，记录证实：

- setValue 只派发一次，expected/actual 均为 Windows-UIA-20261016，matched=true。
- Commit input 调用一次，原生窗口事件日志记录一次保存。
- Increment counter 点击一次，原生窗口事件日志记录 Counter=1。
- 三次输入均 dispatched=true，没有 actionError 或 observationError；随后六次独立观察保持正确结果。
- GUI 实际显示目标缩略图与操作位置指针；任务最终 completed，terminalError=null。

回执为 `.build-cache/platform-handoff-20261016/live/desktop-verified.json`、`desktop-receipt.json`、`desktop-projection.json` 和 `target-events.tsv`。原生测试窗口复用已有 AcceptanceTarget.exe，仅用于输入回读、按钮调用和点击验收，不属于发布包或日常产品界面。

用户随后要求多窗口浮窗检查、移除浮窗下方“停止任务”横条，以及截图去掉白边并保留点击放大。源码已完成后两项：删除 Windows 浮窗专属停止组件，继续使用输入区原有取消入口；Windows 对话图片按钮使用明确的无边框样式覆盖通用按钮内边距，保留原 ImageReview.showModal/close 行为。macOS 图片展示保持原样。对应 TCR 与原有测试已同步。

本轮 `test.sh required` 首次并发运行在既有 loopback_http.rs:215 断言失败。单独运行同一测试通过，随后 `RUST_TEST_THREADS=1 bash ./test.sh required` 通过（GUI 182 项、Session 226 项及其他既有必验检查）。并发失败属于历史上出现过的并发敏感现象，尚未修复，不把串行通过当作修复证据。容器 Git 检查仍跳过，本机 git diff --check 补测通过。相关日志：required-live-ui.log、loopback-live-ui-isolated.log、required-live-ui-serial.log。

中途用户按 Esc 触发 Computer Use 停止后，没有继续界面输入。之后用户明确同意继续接管桌面，才恢复以下实机验收。该暂停记录不计为测试失败，也没有用被打断的点击证明成功。

## 默认字体与剩余验收续项

用户随后明确确认图片白边和点击放大已人工检查通过，要求不再重复这两项，并继续其他验收。默认字体改为已有 `warm-sans`（界面选项名“温和阅读 · 无衬线”）：统一设置缺省与初始 CSS 保持一致，三组 `inherit` 均跟随，已有显式字体选择不迁移，不新增公共设置字段或原生 macOS 逻辑。

按 TCR 调整既有 GUI 默认恢复和 TUI 缺省断言。首轮检查准确暴露 TUI 旧默认断言，修正后 `RUST_TEST_THREADS=1 bash ./test.sh required` 通过；日志为 `required-default-font.log` 和 `required-default-font-final.log`。GUI 构建并更新两个独立验收包，包内真实 Node 导入确认 `gui.fontFamily=warm-sans`，三个分组为 `inherit`。对应日志 `ui-default-font.log`。本机 `git diff --check` 通过。尚未将本次默认值更新重新打入 ZIP/安装包，日常 `bin/win64` 未替换。

SSH 专用容器 `deepcode-ssh-live-20261016` 在本机 WSL Docker 启动，绑定 127.0.0.1:22366，加载本次 `runtime/linux-x64`。首轮公钥认证因旧基底镜像内入口脚本未校正公钥所有者失败；任务容器改用当前准备脚本后，真实 Windows OpenSSH 连接返回 `deepcode-wsl-live-20261016`、`Linux` 和专用标记 `WSL_CONTAINER_ONLY_PLATFORM_20261016`。只配置真实 DeepSeek，无测试 Provider 进程。命令行连通预检不等同 Windows GUI SSH 验收。

## 多窗口、浏览器预览与停止隔离

会话 `session:c71b11bb1cd654ea5a5aaf668a3182df` 使用真实 DeepSeek，通过 GUI 驱动两个专用原生目标 A/B：分别单次 setValue、提交和计数，输入为 MULTI-A-20261016 / MULTI-B-20261016，读回匹配、计数为 1；随后完成 A → B → A → B 精确窗口切换。

桌面 B 与内置 WebView2 页面同时出现独立浮窗，分别拖动、重叠置前和点击显示精确目标均通过。WebView2 在可见及隐藏时的动态帧标记均继续增加；页面 text/saved 为 EMBEDDED-20261016，count=1。浮窗下方没有停止横条，截图去白边及点击放大沿用用户已完成的人工验收，没有重复检查。

另一个 GUI 会话观察 A 时只显示该会话的目标。停止该会话后，原会话 B 和浏览器浮窗仍持续刷新；原任务最终 completed，terminalError=null，浮窗随结束释放。回执包括 `multi-final-projection.json`、`multi-previews-separated.jpg`、`multi-previews-overlap.jpg`、`embedded-preview-hidden-1.jpg`、`embedded-preview-hidden-2.jpg`、`stop-isolation-first-survives.jpg`。

保留操作偏差：重叠验收时一次人工自动化点击使用了被遮挡控件的中心，实际落在前景 B 窗口计数按钮，使原模型验收后的 Counter 从 1 增加到 2。随后依据可见区域完成正确激活；未将额外点击计为模型动作，也未清除原生事件记录。原模型单次计数结论只对应额外点击之前的状态。

## Chrome 真实 MCP 验收

最终成功会话 `session:3d94b092e48e6e11ebddb789559d9413`，8 次 Provider 请求均为 deepseek-api / deepseek-flash。通过 GUI 提交任务，内置 Chrome MCP 完成 6 次操作：new_page、take_snapshot、fill、click × 2、take_snapshot。精确目标 pageId=13、URL 为本机专用 `/chrome` 页面。Kernel 最后快照和页面事件均确认 text/saved=CHROME-20261016、count=1，保存和计数各一次；Run completed、terminalError=null。任务结束后 MCP 进程退出，用户 Chrome 主进程仍运行。

此前两次新运行的 new_page 均在既有 30 秒请求上限后超时，后续同实例调用返回 mcp_server_stopped。用户手动处理 Chrome 连接许可后，带临时阶段日志的一次诊断运行成功。仅新增 connect/context 前后 stderr 标记，没有改变连接、超时、重试或权限逻辑；诊断后恢复两份原包文件并核对一致。前两次超时没有明确权限拒绝原因，不能断言根因或宣称已修复超时策略。用户已允许连接；没有自动点击 Chrome 许可。

证据：`chrome-projection-resume.json`、`chrome-live-projection.json` 保留失败，`chrome-diagnostic-projection.json`、`chrome-evidence-data.json` 和 `page-events.jsonl` 记录成功。

## Windows GUI → SSH → WSL 容器真实验收

通过 Windows GUI 的 SSH 表单选择任务专用 ssh_config、`/opt/DeepCode/linux-x64/deepcode-cli` 和 `/acceptance/user`，连接本机容器后 GUI 显示“SSH · 已连接”。远端目录选择器添加 `/workspace`；没有用 CLI 连通预检替代本轮 GUI 路径。

会话 `session:112f3062f5ba5f22a171129fb2b62a78` 的 8 次 Provider 请求均为 deepseek-api / deepseek-flash，完成三轮：

1. 容器内前台工作区命令返回 hostname=deepcode-wsl-live-20261016、Linux、/workspace，读取专用容器标记；创建并读回 ssh-gui-acceptance.txt，内容为 SSH_GUI_WSL_REAL_DEEPSEEK_20261016。Run completed。
2. 在真实前台 Shell 和 sleep 90 运行期间点击 GUI 输入区原有停止按钮。Kernel ToolRecord 和 Run 均为 cancelled，terminalError=null，GUI 显示“已取消”；保存的 stdout 为 SSH_CANCEL_STARTED_20261016。Shell、sleep、Bubblewrap 均已回收，完成标记文件不存在，原输出归档仍可读取，SSH 连接继续保持。
3. 同一 GUI、SSH 连接与会话继续执行短命令：原文件内容保持，完成标记仍不存在，输出 SSH_AFTER_CANCEL_OK_20261016 和同一容器 hostname，退出码 0、Run completed。

取消命令的工作区权限快照为 read；完成标记不存在只是辅助证据。确定取消结论以执行中真实进程、Kernel cancelled 记录和进程回收为依据，不把未执行的后续写入当作写权限验证。

证据：`ssh-first-projection.json`、`ssh-cancel-projection.json`、`ssh-after-cancel-projection.json`、`ssh-evidence-data.json`、`ssh-running-before-stop.jpg`、`ssh-cancelled-gui.jpg`、`ssh-after-cancel-completed.jpg`。本轮没有新增取消实现；验证的是此前已合入的最小 Linux Shell 确定取消修复。

## 本轮保留的语义边界

关闭旧 Chrome 任务的问题面板会提交“跳过”并继续 Provider 请求。随后在 Provider 思考阶段停止，产生 provider_turn_outcome_unknown / indeterminate，GUI 显示“运行状态待确认”，资源仍完成释放。当前 Session loop.ts 和既有测试明确规定未完成 Provider 请求保留未知终态；此前用户批准的 Linux Shell 取消修复仅适用于执行器已确定终止的前台命令。此次没有把这类 Provider 请求改写为 cancelled，也没有改公共合同、重试或恢复策略。该行为与上面通过的 Shell 停止验收分别记录。

本轮实机续验没有新增产品源码修复。全部源码、测试和默认字体变更已通过先前必验检查；之后只整理原始回执与文档，未重复已验收行为或无关测试矩阵。

## 仍未实测的范围

- macOS 实机助手崩溃恢复、版本提示和 AX 输入回读；本机只有 macOS Host 编译证据。
- 完整 Windows OpenSSH 服务端连接不在用户指定的本轮 SSH 验收路径内；已验证启动命令经过真实 cmd.exe/PowerShell 的标准流，不能等同完整 Windows 服务端验收。
- 本轮 WSL 容器成功不替代 TencentOS / glibc 2.28 远端机器完整验收。
- 签名和安装发布。本轮没有替换用户正在使用的 bin/win64 运行包。

## 复现与证据

测试范围见 [TCR.md](TCR.md)。全部日志位于仓库 .build-cache/platform-handoff-20261016/：
- required-final.log
- windows-host-tests-final.log
- windows-ssh-stdio-tests-2.log
- windows-computer-tests.log / windows-wgc-real-tests.log
- windows-cli-tests.log / windows-tui-tests-final.log
- windows-gui-tests-2.log
- windows-kernel-check.log / macos-host-check.log
- console-registered-test.json / console-font-receipt-final.json
- cloud-patches.json：原始云端补丁备份

仓库已登记专用控制台测试及其显式启用方式；运行前必须提供独立字体目录和新的回执路径。
