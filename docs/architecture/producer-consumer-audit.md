# 状态生产者与消费者边界审查

本轮先检查全部修改 diff，再向全仓库扩展检索。基线为 `6b6ae59ac1ad53cac8ac931e2a3520929159e0f2`（`Achbite-dev`）；结果针对本次工作区修改。审查标准是：内部状态由所有者在变化时发布，消费者使用已发布结果；不能把遗漏发布的问题转化成每个 Agent 的轮询、版本兜底和副本维护。

## 范围与方法

检索覆盖 `crates`、`userspace`、`shells`、`plugins`、`scripts` 和根脚本，包括 Rust、TypeScript/TSX、JavaScript、Python、Shell、Objective-C/头文件与 Swift。排除依赖、构建产物和二进制资源；单独检查本轮测试及协议变更。两轮关键词检索的文件并集为 **191 个候选文件**，不是 191 项缺陷。完整路径、命中行和分类见 [候选台账](producer-consumer-candidates.csv)。此外沿调用链检查了权限提示、recipe、注册表、事务提交和恢复入口。

第一轮检索 `poll / stale / refresh / invalidate / reconcile / cache / mtime / synchronize` 等运行时更新模式；第二轮扩大到 `ensure_ / snapshot / version / revision`。逐类检查谁写状态、谁发布、谁读取，以及失败、重启、并发与同版本更新时的行为。Rust 文件内的测试命中、token cache 计量和时间戳等被单独辨别。静态检索不能证明不存在所有隐藏问题；下表保留已确认的现有欠缺与未判定为缺陷的边界，未把它们写成“全仓无问题”。

## 本轮已修复

| 目标 | 原问题 | 处理与验证 |
| --- | --- | --- |
| 父子权限 | 子会话初始权限与父会话之后的收紧脱节 | Kernel 在 journal 提交边界更新、编译并发布受影响子树；失败不发布。测试在任何工具调用前检查 child/grandchild 已更新，并验证回滚与重启。 |
| Agent 创建 | AgentManager 复制父权限、创建后再提交一遍权限命令，形成第二个状态维护者 | Agent 只传请求的限制；Kernel 对当前父模型做创建准入。CLI 检查没有额外子权限更新事实。 |
| 自动 Plan | Loop 根据原始 run 权限自行自动确认；旧自动 Plan 可以保留收紧前的写权限 | `planAdmission` 由 Kernel 决定；收紧时撤销自动授权；有父 Plan 时必须保留原确认身份。提交端拒绝另造自动授权。CLI 覆盖已有 Plan 失效、新 Plan 等待用户、显式用户确认后写入。 |
| Shell 自动审查 | Loop 比较本地 overrides 判断审查是否过期，无法感知父变化；晚到的结果存在复活风险 | 权限生产者废止旧授权及待完成的自动审查；结果作为历史事实保留，当前 Kernel 准入决定是否能执行。测试覆盖父 `review → ask → review` 后旧结果仍无效。 |
| GUI 投影 | 同一子 journal revision 的继承权限变化被跳过；字段白名单决定哪些更新值得接收 | Kernel 投影发布当前有效权限；GUI 接受同 revision 的完整生产者结果，不用子 revision 代表父权限版本。GUI 与 CLI 回归覆盖。 |
| UI 模块消费 | 每次 lazy import 前先请求发布入口，检查是否有更新，最多阻塞到请求超时 | 模块直接消费已发布资源；独立保留焦点更新提示和真实加载错误。GUI 全量测试通过。 |
| 归档恢复 | 父归档删除后，遗留子会话的历史自动确认可能被当作新授权重新准入，导致无法恢复 | 恢复保留历史事实并将这些授权置为无效；新写入仍严格准入。测试验证孤立子归档可恢复且旧授权不可用。 |

Shell 的操作系统隔离仍归 Sandbox 所有；文件修改仍经 Kernel 的 Plan、目标范围、保护资源和写入门禁。没有以删除这些检查换取通过。模型可组合已安装的 Loop、配置、模型、能力和限制，两个默认 preset 仍只是模板。

## A1–A4 修复与验证

前轮扫描确认的四项问题已逐项修复，并复查本次 diff 与新增发布链路。候选台账保留发现时行号（`discovery_lines`，并非修改后的定位），新增授权索引文件单独登记。以下区分正常发布、明确失败后的恢复与真实的执行准入，不将它们混为消费时检查新旧。

### A1：设置发布及失败重试（已修复）

`settings_api::apply_user_settings_patch` 使用独立发布锁串行化保存、通知及确认；运行态和 GUI 锁在落盘前取得，先准备值，保存成功后只做不会返回错误的内存切换。保存失败不发布部分运行态。读取完整设置视图也经过 runtime transition，避免拼接两个发布阶段的值。等待 Session 确认时释放 runtime transition，允许 Actor 完成运行准备和事实提交。

持久设置是期望状态。每次 PATCH 都交付该 delegation 值，包括相同值重试；交付失败返回明确的 `settings_publication_pending`，不声称未保存。Session 在生命周期开始时读取一次持久值，Actor 激活时先发布它再恢复运行；后续变化通过通知发布。无需 Agent 周期读取设置。其他下一次 run 才激活的设置仍保持该语义。

真实 CLI 场景注入设置路径写入失败和 Session 通知失败，确认保存失败时 settings/runtimeSettings 均不变；确认已保存但通知失败后，相同值重试更新全部活跃 Actor；确认带未交付目标重启后，CLI 激活 Actor 使用已保存的禁用值。测试随后显式重新启用 delegation，才继续子任务。

### A2：子会话的有效权限提示（已修复）

Kernel journal 的写入及初始化响应附带有效权限发布，父变更包含受影响子树；共享 `HttpCommandJournal` 在完成写请求前交付给订阅的 Actor。发布端修订号用于处理 HTTP 响应乱序，不以子 journal revision 推断父权限，也不触发补拉。删除父归档时同样交付子树的新权限。初始化/写入失败恢复的响应包含整个子树，确保父提交确认丢失时，恢复不会遗漏对子 Actor 的发布。

Loop 组合提示时使用已发布的有效权限。审批等待订阅同时携带该发布视图的身份，父更新即使不增加子 journal revision 也能唤醒等待；回归覆盖通知在建立订阅之前和之后到达。CLI 验证收紧后及重启继续运行的真实 Provider 请求中，不再出现自动确认 Plan 的旧提示；旧授权和越界写入仍由 Kernel 拒绝。

### A3：Actor 在提交时发布投影（已修复）

追加接口返回 committed events；命令提交返回 `{ reply, events }`，公共命令回复格式不变。Actor 在通知观察者或返回命令结果前，直接归约这些事实并发布 snapshot。普通 snapshot、Loop 和协调读取不访问 journal。初始化读取一次历史；显式会话修订在写入边界重建投影。

若写请求失败，可能已有持久提交但确认丢失，Actor 在失败的写入边界恢复一次，再允许后续命令；恢复失败则记录不可继续运行的错误。回归分别覆盖写前失败、提交后确认丢失和正常读取不访问存储。CLI 还丢弃已提交父权限的 HTTP 确认，在不再次提交该权限补丁的情况下验证子提示和实际拒绝。真实 CLI 跟踪 journal 读取，确认活跃 Actor 不再增量回查自己的 revision。

### A4：Kernel 授权索引（已修复）

新增 `KernelAuthorityModel`，与权限模型一起在同一 journal 事务中准备，落盘成功后发布。维护当前 Plan、运行状态、当前任务关系、请求绑定、审批证据、撤权、浏览器及执行/文件授权索引；授权查询不再执行 SQL 或归约历史。委派祖先链在任务/Plan/run 变化时计算，消费已发布的原始授权引用。会话删除更新关系；显式会话修订仅在提交端重建该会话的相关事实索引。启动重放一次，历史仍留在 journal。

执行时仍检查身份、授权范围、输入/环境绑定和撤权；没有把调用者提供的 authority 当作授权。索引采用共享的会话快照，事务失败不会污染已发布结果。回归验证原始父授权身份、多层任务结束、Plan 失效、范围绑定、显式撤权、会话修订和自动审批证据时序；原有 Kernel 权限回归全部通过。

## 已核查、保留的边界

| 类别 | 核查结论 |
| --- | --- |
| B1：托管进程 | Kernel 的输出回调和完成线程更新事实；Session 有一次长期订阅，以及结算前同步。后者保证不在进程完成事实到达前结束 run。30 秒 active 采样会产生心跳 revision，是值得单独简化的协议，但未证明为权限副本兜底。 |
| CLI/TUI/GUI 网络观察 | 客户端读取已发布投影、异步请求排序、订阅前读取防丢失唤醒均有边界用途。传输层可后续事件化；本轮不把所有 timer 或 revision 比较判成缺陷。 |
| 外部桌面/浏览器、OAuth、进程存活 | 外部系统可以独立变化；观察有效期、几何/目标校验、token 到期刷新、进程退出检查保留。原生共享流由其回调发布，generation 判断用于阻止已释放资源的晚到回调重新激活。 |
| 环境与 Sandbox 探测 | 在环境修订、新 run 或显式设置边界准备；工具使用已准备 PATH/后端。后端不支持时明确失败，未加入 Agent 回合中的探测循环。 |
| 文件和 UI 插件观察 | Host 观察外部文件并发布订阅流；插件 runtime 管理替换/释放，消费者使用结果。文件可被仓库外工具修改，源文件监视不等于内部权限补偿。 |
| 绑定身份、协议、归档 | Provider/tool binding 的身份验证、事件顺序检查、Plan revision 校验属于契约完整性，未发现“检查失败后自行换成最新实现”的补偿。归档内容按身份固定。 |
| 显示缓存与 token cache | Markdown/已提交文本/文件变化缓存以不可变输入为键；布局缓存由 React commit 作废。大量 cache 命中只是 Provider 用量字段。 |
| 设置 GUI 后续 GET | 当前 PATCH 不返回 runtime/environment 的完整视图，GET 用于补齐契约。可由生产者返回完整 canonical snapshot 简化，不能只删 GET 并保留不完整 UI 状态。 |
| 构建与打包 | build transaction、源身份、依赖缓存和发行产物生成位于生产者生命周期；没有加入运行中 Agent 校验构建产物新旧的路径。 |

## 验证与限制

本轮云端 Rust workspace **389 项通过**（含 Kernel 208 项；不重复计子测试进程），Session **216 项通过**。GUI 测试命令通过全部 9 个测试文件，类型检查、格式和静态检查通过。前轮 Python 构建/界面发布测试 16 + 5 项通过；本轮没有改动这些构建实现，未重复执行。

真实 CLI/daemon/Session bridge/Kernel 配合本地 fixture Provider：组合与权限发布/故障恢复、subagent basic/cancel、权限委托 9 个场景、会话存储均通过。子代理取消用例通过 CLI 的 `cancel <run-id>` 执行取消并要求退出码 8，同时检查父子最终取消事实；最初的一次性 CLI 若已报告待用户回答而退出 5，单独验证该输出，不把它当作取消失败。

没有声称完整 CLI 套件全绿。本轮针对以上受影响链路验证，前轮完整套件中 Todo/回复历史/catalog release 等既有断言差异仍保留。云主机 Bubblewrap 的 uid map 受只读文件系统限制，workspace Shell 原生隔离未完成验证；macOS/Windows 原生隔离未在本机实测。没有真实外部模型推理或大规模分布式集群测试。

通过日志归档在云工作区 `/workspace/deepcode-cloud/evidence/producer-publication-fixes/`；前轮证据位于 `agent-composition-audit/`。
