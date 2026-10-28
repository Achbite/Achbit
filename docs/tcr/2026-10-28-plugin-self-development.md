# 插件自研发与同轮生效 TCR

用户选择同一轮安装后在后续模型步骤使用新能力，并要求保护缓存命中。

必要性：这次改变了插件注册生效边界以及 GUI/CLI 共享管理合同。原有测试只覆盖已登记插件的激活，不能证明运行中安装、更新、移除与稳定请求前缀同时成立。

聚焦覆盖：
- Kernel 仅刷新插件注册；Provider、环境及权限默认值保持 run 快照；未变更注册复用视图。
- 安装/更新/启停/移除复用安装与设置 owner；服务启动失败保留实际状态。
- Session 在工具批次结束后的模型请求边界观察新目录；旧执行绑定保留至退休。
- 既有工具 wire name 与顺序保持稳定；新增指引追加到历史，已发送消息不被改写；禁用工具确实撤下。
- CLI 参数与共享 Host API；GUI 外部设置变更通知和读取串行化。

使用既有 Rust 单元测试、Session node:test 与 GUI 合同测试。只增加上述目标行为的断言，不修改默认 profile、不放宽既有断言、不添加测试专用生产分支。Debug 运行与真实 Provider 的证据另行报告。

既有激活测试调整：安装目录现在可以在显式激活之前刷新，故“激活对应首个 run.tools.prepared”不再成立。仍严格比较激活事件与其之后紧接的工具视图身份，不放宽调用绑定、可用性或终态断言。

本轮结果（2026-10-28）：
- `bash ./test.sh static` 通过。容器 `CARGO_BUILD_JOBS=1 bash ./test.sh required` 全部通过，入口跳过 0；包括 Rust 工作区与 Debug 合同、352 项 Session、308 项 GUI、20 项 TUI 检查及类型接线。首次并发链接被系统以 signal 9 终止；改为单编译任务后完成同一入口，未修改测试范围。
- macOS arm64 Debug 包通过现有 `build.sh -debug --stage package-macos` 构建；沿用已存在的开发签名身份。版本保持 0.6.61，本轮修改尚未提交。
- 独立 Debug GUI/Host 中，从随包模板安装 CLI、service、UI、guidance 四类插件。真实 CLI 工具调用前后分别返回原统计结果和 revision 2；既有 Shell 权限批准后可通过 CLI 更新同一 Host 的 Skill。
- 服务更新关闭旧端口，启停/移除关闭对应进程，更新保持 stateDirectory。真实启动失败返回非零退出及 failed application，保留原日志位置。
- UI 安装/更新先返回 client-pending，窗口加载后返回 active；同一窗口显示 V1→V2，停用后撤下；apply 抛错返回原错误，更新修复后恢复。原生窗口观察及截图支持此范围。
- 示例注册已全部移除，本轮 GUI/Host 已停止，stop 回执 cleanupComplete=true。操作回执保存在 `/private/tmp/achbit-plugin-debug.xOdo4a`；独立运行状态和示例工作目录已清理。

初次验证边界：Session 测试严格比较八次请求的历史前缀、稳定系统消息、Provider identity、追加的工具声明及更新/撤下语义；真实 Debug 验证证明管理、Kernel 执行、服务与 UI 链路。当时独立 Debug 模型连接处于 unconfigured，真实 Provider 与缓存用量随后按用户授权补测。

真实 DeepSeek 补测（2026-10-28）：
- 按用户明确授权，通过现有 CLI 配置接口及 stdin 使用正式包中已配置的 DeepSeek API 凭据，仅写入独立 Debug 状态；正式配置未修改。使用原有 `deepseek-flash`、Responses、Thinking/max 配置。
- Session `session:1248d75fe09766d0ebd2bf566a242c55` 完成；24 次主模型请求保持同一 run 和同一 Provider runtime。模型自行读取文档、生成插件源码、安装、发现、激活、调用、更新和禁用，控制端只确认已有授权范围内的具体 Plan/执行请求。
- 第一次实际工具调用返回 `{characterCount:21,wordCount:4,revision:1}`；模型更新源码和工具描述后，第二次返回 `{characterCount:21,wordCount:4,digitCount:2,revision:2}`。安装、激活、更新、禁用形成四次工具视图变更；禁用后下一次请求撤下工具。
- Provider 原始用量：主 Agent 输入累计 715,587 tokens，其中缓存读取 617,728，按输入加权命中率 86.32%；24 次均有用量回报。另有 1 次标题请求，输入 406 tokens，未计入主 Agent 比率；全部 25 次物理请求的用量均已回报。
- 安装后尚未激活的首个请求命中率 96.21%；首次激活后 16.55%，下一次 99.49%；更新描述后 15.62%，下一次 99.64%；禁用后的请求为 88.65%。工具变更当次仍有明显缓存代价，后续恢复复用。此次没有修改前后的 A/B 对照，不能据此量化改动带来的提升或承诺一般命中率。
- 保留真实恢复过程：沙箱读取 Host/包外文档受限后改用明确权限；首次文件写入因缺少已确认 Plan 被拒；Plan 参数被拒三次（一次不支持的 status 字段、两次不合法的绝对 writablePaths），模型随后自行修正。模型最终自述只计了两次，记录以原始事件的三次为准。插件安装、更新和两次真实插件调用均成功，没有插件执行失败。
- 结构化回执：`/private/tmp/achbit-plugin-provider.8TxD2a/real-provider-result.json`；同目录保留原始 Provider 用量与任务终态。验证完成后移除示例注册并停止本轮 Host，清理独立运行状态及其中的凭据副本。
