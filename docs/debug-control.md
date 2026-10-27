# Achbit Debug CLI 速查

Debug 用于独立、定向验证。工具和 UI 操作直接调用接口，不需要模型或 Agent Loop；只有验证 Session、Provider 或模型审批本身时才启动任务。生成 Debug 包不等于执行标准安装包、CLI/TUI 或发布验收。

## 启动

在项目 Docker 构建入口执行 `bash ./build.sh -debug --stage package-macos`，Windows 使用 `--stage package-windows`。产物分别在 `bin/debug/macos-arm64`、`bin/debug/win64`，不生成 Setup/PKG；Linux 不支持 Debug 构建。

在产物目录中运行，测试工作区须已存在：

```sh
./achbit-debug launch --artifact . --workspace /absolute/test-workspace --state-root /absolute/debug-state
export ACHBIT_USER_ROOT=/absolute/debug-state
./achbit-debug inspect
```

Windows 使用 `.\achbit-debug.cmd`，PowerShell 中设置 `$env:ACHBIT_USER_ROOT = 'E:\debug-state'`。每个连接命令都需要显式状态目录；不要复用标准版数据或默认复制其凭据。

## 启动分段诊断

需要诊断启动延迟时，给目标进程设置 `ACHBIT_STARTUP_TIMING=1`。GUI 和它启动的 Host 会在 stderr 输出 `[startup-timing]` 记录，只包含阶段、PID、墙钟微秒和进程内经过时间；默认关闭，不含连接令牌或用户内容。GUI 的记录在其 stderr，Host 的记录在该实例启动诊断目录中的 `daemon.stderr.log`。

`gui.window_begin` 到 `gui.index_begin` 覆盖原生 WebView 建立和首次导航；`gui.index_begin` 到 `gui.index_end` 只测入口 HTML 的路径解析与资源读取。之后需结合 WebView 内的模块、请求和可见控件观测，不能把资源读取完成等同于首屏可用。

使用外部发起启动的时间与 `gui.entry` 区分入口前等待，再比较 `gui.daemon_start`、`kernel.entry`、`kernel.published`、`gui.daemon_ready` 和 `gui.proxy_ready`。`kernel.execution_finished` 只表示初始化结束，成功或失败仍以 readiness/health 的原始结果为准。不同线程和进程的区间可能重叠，不能机械相加；新制品首次运行、同路径再次运行与清空系统缓存后的冷启动也应分别记录。

## 接口选择

| 目标 | 命令 |
| --- | --- |
| 查看工具 | `tools list`、`tools inspect --tool NAME` |
| 直接执行 | `tools call --tool NAME --input JSON`；异步提交加 `--no-wait` |
| 等待结果 | `operation inspect --operation-id ID --wait-ms 180000` |
| 回应工具授权 | `operation respond --operation-id ID --decision-id ID --decision allow\|deny` |
| 插件目录 | `components list`、`components inspect --uri URI`、`components activate --plugin-selections JSON` |
| 查看界面 | `surfaces list`、`surfaces inspect --target main` |
| 操作界面 | `action --target TARGET --name ACTION --args JSON` |
| 验证 Agent 任务 | `task submit --text TEXT --follow` |
| 跟随已有任务 | `observe subscribe --session-id ID`，再 `observe --subscription-id ID --follow` |
| 读取原始结果 | `result read --operation-id ID`、`--record-id ID` 或 `--session-id ID --event-sequence N` |
| 查询计时/用量 | `metrics query --kind tool\|ui\|component\|session\|provider` |
| 清理本轮实例 | `stop`；`detach` 只解除控制，不取消任务 |

以上命令均接在 `./achbit-debug` 后。参数可用 `@JSON文件`。先 inspect 获取实际 selector、组件 ID、动作签名和可用性；不要猜工具或控件名。

直接工具上下文目前不提供 run 所属的浏览器/桌面绑定，激活 Computer Use 不等于这些工具可调用。适用时使用 GUI 的 surface/action；缺少入口时报告限制，不为构造界面状态另搭模拟 Provider。

UI 动作可通过 `waitFor` 等待 DOM 或组件状态。动作返回不等于业务完成；`partial` 和非零退出码保留原始错误及观察缺口，不重放已执行动作。需要视觉确认时读取原回执的截图；归档或呈现不等于向模型加载图片。

任务观察使用一条 `--follow` 连接，按批次接收文本、工具、决定和终态，不轮询状态。按任务自身终态判断成功，不以观察流关闭代替完成。

完整参数与示例见 [Debug control](product/debug-control.md)，产品内通过 Shell 读取 `productDocsPath` 下的同名文件。构建不更新运行进程；只在授权范围内重启目标 GUI/Host，标准版保持独立。
