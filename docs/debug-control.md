# DeepCode Debug CLI

通过 `bash build.sh -debug` 构建当前可用的 Windows/macOS Debug 版本；只构建 Windows 时使用 `bash build.sh -debug --stage package-windows`。目录运行包和归档只写入 `bin/debug`，不生成 Setup/PKG，不安装全局命令。保持解压目录中的应用、启动器和 runtime 相对位置。

Windows 应用为 `bin/debug/win64/DeepCode-Debug.exe`，启动器为 `deepcode-debug.cmd`，直接打开时使用 `%LOCALAPPDATA%\DeepCode-Debug`。macOS 应用是 `bin/debug/macos-arm64/DeepCode-Debug.app`，启动器为 `deepcode-debug`，直接打开时使用 `~/Library/Application Support/DeepCode-Debug`。应用标识和默认用户目录均独立于普通 DeepCode。CLI 控制必须显式指定独立状态目录与测试工作区。普通构建不包含这些控制接口，但普通对话计时和过程标题旁的用时展示不受 Debug 开关限制。Linux Debug 阶段明确报告不支持。

## 启动与接管

在解压目录运行以下命令，将示例路径替换为自己的绝对路径。工作区须已存在。

```sh
./deepcode-debug launch --artifact . \
  --workspace /absolute/test-workspace --state-root /absolute/debug-state
export DEEPCODE_USER_ROOT=/absolute/debug-state
./deepcode-debug inspect
./deepcode-debug --help
```

Windows PowerShell 示例（后续命令使用 `deepcode-debug.cmd`）：

```powershell
.\deepcode-debug.cmd launch --artifact . --workspace 'E:\test-workspace' --state-root 'E:\debug-state'
$env:DEEPCODE_USER_ROOT = 'E:\debug-state'
.\deepcode-debug.cmd inspect
```

Windows GUI 使用 WebView2 等待异步动作完成并捕获目标视口；原生文件选择器通过 UI Automation 暴露实际 `nodePath`、可用动作和属性错误。`dialog.press` 使用已公布的 `Invoke`，`dialog.setValue` 传 `value`，`dialog.selectRow` 选择观察到的行；携带 `dialogId` 可校验对话框身份。选择/取消仍以 `nativeDialogs.lastResult` 的原生结果为准。截图仅覆盖本程序的选择器，系统权限或外部窗口不在此接口内。Windows 原生菜单使用 `surfaces list` 返回的 `itemPath` 和 `menu.select`。

`launch` 启动独立 Host 和 GUI，返回实例、控制身份与目录。`--headless` 只启动 Host。已有实例使用 `attach --workspace ...` 接管；`detach` 结束控制但不等于取消任务，`stop` 关闭当前启动器拥有的 GUI 和 Host 并返回生命周期结果。模型设置在此独立实例中配置，不自动复制稳定版凭据。重新打包不更新正在运行的进程；新 GUI 也可能连接已有 Host，验证 Session、Kernel 或内置指导修改时应确认实际加载的进程。

GUI 启动最多等待 20 秒，确认进程仍在、控制端已注册、主工作台已加载且 Host 已连接。`gui` 字段报告就绪和耗时；提前退出或未就绪返回非零退出码，保留本轮归属回执供 `stop` 清理。仅生成 PID 不代表 GUI 就绪。

## 工具、组件和界面

```sh
./deepcode-debug tools list
./deepcode-debug tools inspect --tool fs.read
./deepcode-debug tools call --tool fs.read --input '{"path":"one.txt"}'
./deepcode-debug components list
./deepcode-debug surfaces list
./deepcode-debug surfaces inspect --target main
```

`tools call` 直接进入 Kernel 工具执行链，不创建 Session、Provider 或 Agent Loop。每次 `fs.read` 仍只接收一个文件；多个独立调用可并发执行，最多四个在途执行。可并发启动 CLI 调用，或用 `--no-wait` 连续提交后以 `operation inspect --operation-id ... --wait-ms 180000` 等待结果。普通 Agent 也可并行调度连续独立 read，写入及其他工具保留顺序边界，不新增多文件 read 输入。需要授权的操作返回 `operationId` 和决定信息，使用 `operation respond` 沿既有权限批准，或用 `operation cancel` 取消。失败终态使用非零退出码。

`action --target ... --name ... --args JSON` 控制产品界面。先 inspect 获取真实目标和控件，再调用对应动作；结果包含状态、截图引用和计时。DOM 点击会检查实际命中目标，遮挡返回原始失败。`components list/activate` 复用 Kernel 插件目录；GUI 组件实例及其可调用动作来自 surface inspection，使用 `plugin.action` 和返回的 `componentId`、`action`、`arguments` 调用。回调返回不等于异步业务结束，提交消息仍沿原 Session 执行。系统权限和外部登录窗口不属于产品控制面。

组件 owner 可声明当前可用性、不可用原因以及自己确认的业务完成语义；未声明时保留 `not-declared` / `not-asserted`，调用前再次检查。会话切换会从真实目录加载外部创建的会话，确认投影已加载才返回 `session-loaded`。

动作可附带 `waitFor`：DOM 条件使用观察到的 `selector` 和 `text/value/visible/absent`；组件条件使用观察到的 `componentId`、输入字段路径 `path` 和目标值 `equals`，例如 `{"componentId":"实际ID","path":["data","activeSessionId"],"equals":"目标Session ID"}`。等待最长 15 秒；状态条件匹配不代表 Agent 已完成执行。

文字和元素截断明确报告覆盖范围，DOM 控件列出支持动作和禁用/只读状态。条件超时保留已执行结果和原始错误，继续取得动作后的观察与截图。未取得渲染边界、截断观察、缺失测量或截图会返回 `partial` 与 `observationFailures`，CLI 非零退出，不重放动作。控制 Agent 应读取同一回执的 `screenshot.contentRef` 原图；组件测量保留自身身份，不能把同期采集等同为全部由该动作造成。

## macOS 原生文件与目录选择器

先从产品的“文件和文件夹”入口打开真实选择器，然后查询：

```sh
./deepcode-debug surfaces inspect --target native-dialog
./deepcode-debug action --target native-dialog --name dialog.inspect --args '{"nodePath":[]}'
```

`accessibility.nodes` 提供实际控件的 `path`、角色、文本、文件路径、属性和动作。`nodePath` 使用这份树中的数字数组；建议同时传入本次 `dialogId`，避免把旧面板的路径用于新面板。检查器按广度优先最多返回 512 个节点，超出预算明确返回 `truncated: true` 和 `coverage: partial`。可将已观察节点的路径传给 `dialog.inspect`，仅查看该子树；返回路径仍相对于所属选择面板。单项属性读取失败保留在该节点的 `attributeErrors`，不补造属性值。

- `dialog.press` 接收 `nodePath` 和可选 `action`（默认 `AXPress`），仅执行固定允许范围内且该节点实际公布的动作。目录浏览不能把 `AXOpen` 当作展开目录；它可能直接确认选取。
- `dialog.selectRow` 接收实际列表的 `collectionPath` 与其直接行节点的 `nodePath`，验证 `AXSelectedChildren` 可写后选择该行。侧栏等直接可选行可只传 `nodePath`，使用可写的 `AXSelected`。选择目录后观察实际下一列及 `directory`，选择文件后观察 `selected`。
- `dialog.setValue` 接收可编辑控件的 `nodePath` 和字符串 `value`，操作其真实 `AXValue`。
- 确认时从树中找到实际确认按钮，调用 `dialog.press`；`dialog.cancel` 取消当前产品所属面板。

动作接纳或 AX 返回值不代替最终选择结果。原生完成回调保存在 `nativeDialogs.lastResult`：`selected` 附真实路径，`cancelled` 表示取消。动作结果同时保留原始错误、面板状态和截图；若派发错误与完成回调同时出现，两项事实分别保留。截图只采本产品所属选择面板。系统权限不足明确返回实际错误，需要人工处理系统授权窗口。

## 任务与主动观察

```sh
./deepcode-debug task submit --text '读取 one.txt 并报告内容' --follow
./deepcode-debug observe subscribe --session-id SESSION_ID
./deepcode-debug observe --subscription-id SUBSCRIPTION_ID --follow
```

任务使用已有 Session Loop；直接工具和 UI 动作不创建 Loop。`task submit` 在执行前建立订阅，单独 `observe subscribe` 订阅已有任务的未来事件。观察以 JSONL 主动输出：首段文本与工具后文本在完整片段或最长一秒窗口交付，并附前面的工具事实；必要交互和终态立即交付。连续工具按 100,000 估算 token 或 180 秒成组交付，可通过 `--input-budget-tokens` 限制接收上下文预算。交付大小估算不等于 Provider 计费 token。

运行中子任务的提问、审批和 Plan 决定也立即送达其任务拥有者的观察订阅。此类条目保留 `sourceSessionId`、原始事件身份和 `agentRoute`；回复或读取原事件时使用子会话身份，不能使用外层父会话的 `sessionId`。父会话 `lastEventSequence` 仍只指父 journal，不混入子会话序号。这一通知不唤醒父会话的业务 Loop，也不复制子代理的全部轨迹。

`observe --wait-ms ...` 最长等待下一次交付 180 秒；不带 `--follow` 时返回一次交付或超时状态，带 `--follow` 时沿同一连接继续接收。安静超时返回 `observation.wait_timeout`、当前状态及 `modelInput: false`，不取消任务，也不应唤醒一次模型分析。控制方无需频繁查询状态或把每个流式片段单独送给模型。观察失败明确报告，B 继续原任务；不自动重连或重放。运行中仍可通过 `task message --session-id ... --text ...` 沿原输入队列提交后续对话。

子代理配置保存在各自 Session。先用 `task inspect --session-id SESSION_ID` 读取 `subagentSettings`，保留完整配置并修改需要的字段，再用 `task respond --session-id SESSION_ID --command @settings-change.json` 提交 `{"type":"session.subagent-settings.set","settings":完整配置对象}`。一次新接纳的保存也更新未来会话的默认值，但不改其他已有会话；重复命令不再次覆盖默认。关闭只阻止新的委派，已运行子任务继续。GUI 新会话草稿修改也保存为默认，创建本身仅复制配置。配置操作不发起 LLM 请求；启用后的模型提示鼓励在已授权任务内主动委派有用的独立工作。

`--follow` 保留完整终态回执；观察对象自己的 `run.settled` 报告失败时，CLI 返回非零退出码。观察流正常结束不代表任务成功。

## 用量和耗时

```sh
./deepcode-debug metrics query --kind tool --tool fs.read --group-by tool,status
./deepcode-debug metrics query --kind ui --event click
./deepcode-debug metrics query --kind session --session-id SESSION_ID
./deepcode-debug metrics query --kind provider --session-id SESSION_ID
./deepcode-debug metrics query --kind component --group-by component,event
./deepcode-debug metrics export --kind tool > tool-metrics.jsonl
```

工具记录可按 operation、call、attempt、run、session、状态、绑定和时间筛选；保留排队、准备、授权等待和执行测量，Kernel `timing` 字段以微秒 `Us` 表示。并发 read 的线程累计时间与墙钟区间分别报告。界面指标保留事件、组件、阶段和时钟域，回调、状态观察、截图分别以毫秒 `Ms` 测量；双动画帧边界不等于真实绘制时间。聚合只覆盖返回的样本，未知/缺失项不当成零，不跨时钟域相减。

Session 保留首响等待、首响类型、响应后用时及总用时。首个有效响应取可见文本与 Session 接纳的完整可执行工具调用中较早者，隐藏推理、工具参数碎片和心跳不计。普通版与 Debug 版会话中，原“展开执行过程”旁显示已记录的首响至结束用时，点击仍展开中间过程；历史缺失事实不根据消息时间补造。物理 Provider 用量来自既有用量存储，缺失用量明确标记；会话自身及包含子代理的统计是不同范围，外部控制方 Codex 的 token 不由 B 推算。

首次自动标题属于独立辅助请求，在 `metrics query --kind provider --session-id ...` 的记录中标记为 `purpose: conversationTitle`，保留实际 token、`completedAt` 和 `durationMs`。它不伪造正文的 run 或 Provider attempt；尚未结束或被取消而未取得结束测量时，结束字段为 `null`。

大型结果可通过 `result read --operation-id ...`、`--record-id ...` 或 `--session-id ... --event-sequence ...` 读取事实源。JSON 参数可使用 `@文件路径`，结果写 stdout，错误写 stderr。

界面 fixture 可以加载真实组件和样式，但模拟传输仍只证明对应预览场景；CLI 动作、真实 Provider、原生选择回调和普通安装包的运行结果分别保留。构建成功不代表当前产品已更新。产品内 Agent 可通过 `doc.read` 读取英文 [Debug control](product/debug-control.md)，并通过 `skill.read` 加载 `deepcode-iteration` 的迭代流程。
