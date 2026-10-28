# 第一批简化：Session Host 服务端口 TCR

用户于 2026-10-28 授权按分析结果分两批清理，并要求每批以基础 CLI 对话确认运行链路。本项只收窄 Host-facing SessionServicePort 的强制方法集合，保留具体 SessionService、Actor 的 replaceCapabilities 入口以及请求级能力租约、替换和释放语义。

必要性：Bridge 的 IPC 分发并不调用 replaceCapabilities，但启动时仍要求每个服务实现提供该方法。现有 agent-composition-cli.py 以自定义 Session 服务模块覆盖真实 CLI → Host → Session Bridge → Loop 链路；复用该 fixture 隐去同进程能力替换方法，即可覆盖端口收窄，无需新增框架或测试专用生产逻辑。

旧/新不变量：

- 旧：自定义 Session 服务必须实现 replaceCapabilities，否则 Bridge 在启动时拒绝加载，即使所有实际 IPC 方法完整。
- 新：自定义服务具备实际 Host IPC 操作和 dispose 方法即可加载；同进程 operator 方法不再是 Host 服务的必需条件。
- 保留：缺失真实 IPC 方法仍由现有启动校验拒绝；自定义服务仍通过原 Actor、提交、取消、Kernel 和 journal 路径工作；具体 SessionService 和 Actor 的能力替换方法及在途请求绑定不变。

测试变更：仅修改 scripts/tests/agent-composition-cli.py 的既有自定义服务模块 fixture，将其 replaceCapabilities 置为 undefined。保留原 CLI 请求、定制 runner、权限、失败与资源释放断言。该 fixture 在旧 Bridge 校验下会因缺失该方法启动失败，在新端口合同下应沿原链路运行。

验证范围：主任务统一执行适用的容器基础检查和本批基础 CLI 对话。专项 agent-composition-cli.py 若执行则单独记录；基础对话不宣称覆盖定制服务缺少 operator 方法的专项场景。本子任务不执行测试、构建或 Provider 调用。

当前状态：源码与最小回归 fixture 已调整；运行结果由主任务在实际执行后补充。未提交、未推送。

首次专项失败及修正：
- 第一批基础 CLI 对话已由主任务完成；补跑现有 agent-composition-cli.py 时，COMPOSE_CHILD 的 mock Provider 报出 KeyError('fs.write')，随后因 fixture 中断 SSE 返回 provider_stream_native_terminal_missing。原始日志保留在 .build-cache/simplification-20261028/batch1-service-chain.log。
- 源码和 HEAD 512ca92 对照确认：两个写入子任务未显式选择 preset，而既有默认 analysis 只选择 fs.read、禁用可选 controls 和插件；这与 fixture 随后要求写入、Plan/问题控制和 Host 路由拒绝的场景不符。当前生产默认和目录过滤在本项中没有改变。
- 最小修正：COMPOSE_CHILD 与 PERMISSION_CHILD 的 spawn 输入显式使用 collaboration；该预设按现有合同继承父任务工具选择和权限。本轮仍保留原父 Plan 授权、越界写入拒绝、Host 拒绝、权限收紧、恢复及最终文件内容断言；不扩大生产默认能力，不改变通过/失败结果。
- 该结论是首次运行日志与当前/HEAD 源码对照得到的 fixture 配置失配定位，未另跑基线。修正后的专项结果由主任务复验后记录。

## 本批实际结果

共享包构建与 Session 聚焦测试通过；显式选择 collaboration 后，既有 agent-composition-cli.py 整条定制服务、父子权限与恢复链路通过，包含缺少 replaceCapabilities 的端口验证。首次 fixture 失败及定位保留于前述记录。

第一批使用本次容器开发产物，经真实 DeepSeek Flash 完成文件读取与同一 Session 追问两轮 CLI 对话；两轮均 completed、退出码 0，临时 Host/状态已释放。回执：`.build-cache/simplification-20261028/batch1-cli.json`。该结果仅证明基础 CLI 链路，不代表原生 GUI、标准包或跨平台验收。
