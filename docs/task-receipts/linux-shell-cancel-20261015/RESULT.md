# Linux 工作区 Shell 取消终态修复验收

2026-10-15，Windows GUI → SSH → 本机 WSL 容器，使用已配置的真实 DeepSeek API。先完成 TCR，再修改实现和测试。

## 实现

- Kernel 仅对 Linux 内置前台工作区 Shell 正常返回的 `tool_execution_cancelled` 结果记录 `cancelled`，保留执行输出。执行器必须已完成进程回收、输出归档与临时资源清理；清理失败、未知结果、其他工具及后台任务仍保留原有不确定语义。
- `ToolExecutionRecord.cancelled` 允许可选 `output`，仍禁止 `error`。同步 Session 的 Shell 投影、模型上下文与 GUI 校验；执行前无输出的取消仍有效。
- 复用既有停止、取消回执、Run 结算和 GUI 状态文案；不修改 macOS 平台代码或取消判定，不变更数据库结构、版本或历史记录。取消不代表副作用回滚。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| Rust 聚焦回归 | 确定取消、输出归档、重复取消、清理失败、范围限制均通过；源码平台条件限定 Linux，未运行 macOS 测试。 |
| Session / GUI 合同回归 | 有/无输出取消均通过；拒绝非法 Shell 结果和取消记录携带 error；继续对话保留取消事实及部分输出。 |
| `test.sh required` | 退出码 0。Rust workspace、构建/发布脚本测试、223 项 Session 测试、177 项 GUI 测试、GUI 与手工预览类型检查均通过。容器因宿主 Git 元数据不可用跳过 diff 检查，Windows 工作区已补跑 `git diff --check` 通过。 |
| Windows / Linux 正式打包 | 两个平台成功，生成 Windows ZIP/安装程序及 Linux tar.gz。macOS 未构建。 |
| glibc 2.28 兼容程序 | 使用已有工具链重建四个 Rust 程序，全部最大要求为 GLIBC_2.28；旧程序已备份，bwrap 保持原兼容程序。 |
| Windows SSH | 更新后 CLI 检查就绪，真实 GUI 显示 `SSH · 已连接`。 |
| 真实 DeepSeek 只读任务 | 一次 Shell 调用输出容器主机名、Linux、`/workspace` 和既有容器标记；ToolRecord 与 Run 均 completed。 |
| 真实 GUI 停止 | 长命令运行期间点击既有停止按钮；ToolRecord 与 Run 均 cancelled，terminalError 为 null，GUI 显示“已取消”，SSH 仍连接。 |
| 进程与输出 | 停止前 PID 221/224/225/226 对应两层 bwrap、bash 和 sleep；停止后匹配进程为空，且四个 `/proc/<pid>` 均消失。保留 27 字节开始标记，stdout 归档与记录一致，无完成标记；success=false、exitCode=null、timedOut=false。42,903 ms 是命令总运行时长，不是取消延迟测量。 |
| GUI 输出与续聊 | 工具详情可见开始标记和已取消状态；真实 DeepSeek 续聊准确引用 cancelled、部分 stdout 与 42,903 ms，未再调用工具。 |
| 历史保留 | 修复前的 indeterminate 记录仍保留，未改写为成功或取消。 |

## 实机身份与证据

- 会话：`session:ffc8abdc28cb0aedb952030ae993b3fc`。
- 停止 Run：`session:ffc8abdc28cb0aedb952030ae993b3fc:run:mv92z9yz:c`。
- 实际 Provider：`deepseek-api` / `deepseek-flash`，本次共 4 个模型请求，来自 GUI 只读任务、长任务与续聊。
- 容器实际加载的 Kernel SHA-256：`728e5b98967783b6f7abc251d06cffc6dcc435de66ecb5ef1406bb26714fed6f`，与本次兼容构建一致。
- 精简实机记录：[acceptance.json](acceptance.json)；兼容构建记录：[compatible-build.json](compatible-build.json)；测试说明：[TCR.md](TCR.md)。
- 原始 required/package 日志、进程快照与 GUI 可访问性观察保存在同目录本地文件中，不随代码提交。

## 交付边界

构建基于 `67db045763191c6cc4710605e5581b394c03701c` 加本次工作区修改。正式包的 `BUILDINFO.sourceCommit` 保留构建流程实际产生的 `unknown`；兼容构建另记 baseCommit、sourceChanged 与源文件哈希，没有伪造为干净提交。

本次已验证 Windows GUI 到本机 WSL SSH 容器的完整链路；未部署内网 TencentOS 主机，也不将 ABI 检查表述为该主机实机验收。API Key、Host Token、SSH 私钥均未纳入证据提交。
