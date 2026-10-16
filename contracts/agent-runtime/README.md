# Agent Runtime 合同资产

产品发布说明见[项目 README](../../README.zh-CN.md)。产品版本、制品 `BUILDINFO.json` 与下面各 owner 的 schema 版本独立维护；发布产品新版本不会自动提升数据库版本。

本目录只保存当前本地 Agent Runtime 的机器合同。它没有迁移脚本、兼容 alias、双读、双写、旧根 fallback，也不包含第二套 Session 或 Kernel 执行路径。

## 当前合同

| 事实 owner | 当前建库合同 | 当前 `user_version` | 负责内容 |
| --- | --- | ---: | --- |
| Host Catalog | `catalog.sql` | 2 | Project、Host 私有 workspace、项目目录索引模板、Session 归类、原文件与目录定位、Session-owned 文本资源和工作目录 |
| Session | `session.sql` | 7 | Session creation snapshot、journal、命令回放、对话目录索引、跨 Run Plan/Todo、Provider turn 终态、control 拒绝、请求回执、用量与 Run runtime 释放回执 |
| Kernel | `tool-record.sql` | 1 | Session 保留期间不可变的 ToolRecord |

`schema.json` 是 UI、CLI、TUI、Host、Session 与 Kernel 之间的当前 wire schema。SQL 只约束各自 store 的持久化边界，不能替代 wire schema，也不能跨 owner 推断另一层事实。

`ToolExecutionRecord.outcome=cancelled` 表示执行已取消，不保证取消前的副作用已回滚；允许可选 `output` 保存停止前的输出，仍禁止 `error`。执行前取消可以没有输出。Linux 内置前台工作区 Shell 只有在受控执行器完成进程回收、输出归档与临时资源清理并返回明确取消结果后，才生成带输出的取消记录；清理失败或结果不明仍为 `indeterminate`。此扩展不改变数据库版本与历史记录，消费方需接受取消记录中的可选输出。

模型 Profile 和侧边栏排序属于 Host 用户配置。模型配置错误通过设置接口保留并展示，不阻止 Host 打开有效的 Session store；运行请求仍要求可用的模型配置。GUI 排序不改变 Catalog 的项目归属或 Session 的语义事实。

同一个配置根在任一时刻只有一个 daemon owner。daemon 在读取权威配置和打开三个业务 store 之前，必须持有 `<data_dir>/agent-runtime/root-owner.lock` 的进程生命周期租约；同根的第二个 daemon 以 `config_root_already_owned` 显式失败。`data_dir` 是 Host 的持久数据目录，平台路径与独立用户根规则见[用户目录](../../docs/distribution.md#用户目录)。该文件只是由操作系统锁生命周期约束的 owner 租约，不是第四个业务事实 store，进程退出或崩溃即释放所有权。

Catalog 拥有可变的 Session 标题和 Project 归类。Session projection 的 `display.creationTitle` 只保存不可变的创建标题，不得作为当前标题或归类的第二权威源。Host shell 通过 projection snapshot 拉取消费 Session 事实；当前合同没有 projection subscribe/SSE 推送路径，各 shell 可以按自己的展示节奏轮询同一个 snapshot 端点。

Provider 原生 `callId` 与 Session `LogicalCallId` 是两种身份。Session 在每次 Provider turn 为 call 生成独立且不复用原生值的 LogicalCallId；journal payload 以 `providerCallId` 保留 Provider 身份，顶层 `callId`、Interaction/Plan identity、Kernel request、ToolRecord 和 Session 重放使用 LogicalCallId。

Session projection 的 `tokenUsage` 保留当前会话自身口径；`totalTokenUsage` 由 Session 沿既有 Agent 创建关系汇总当前会话及全部后代，每个 sessionId 只计一次，包含已经关闭的成员及其多次任务。用量来自各会话已有的 Provider 记录，不从 GUI 可见任务数推算，也不新建用量事实表；缺失用量保留 unavailable/partial。上下文估算和 Host 费用报告仍使用各自原有口径。

委派开关变更以 `agent.delegation.changed` 进入已有 Session，保持通知顺序，不启动空闲 Loop。新建与续派任务按最新 Host 设置准入；关闭委派不取消已经运行或等待的子任务，也不删除消息、执行历史或用量。Plan 用于新增或扩大的授权，Todo 仅表达按需进度，两者不替代 Kernel 执行事实。

`message.submit.filesystemReferences` 是文件与目录共用的消息级逻辑引用。Host 登记原文件或原目录的位置，不复制文件到 Session 私有目录。Session 只持久化 `referenceId/workspaceId/logicalPath/displayName/kind` 及文件媒体元数据；这些引用扩充请求的资源查找视图，不增加 run 的工作目录绑定，也不授予工具读写权限。run 的工作目录绑定在启动时由 Session 目录索引冻结。普通文件向 Provider 提供逻辑 workspace handle 与逻辑路径，内容按需通过基础文件工具读取并遵循既有权限规则；当前 run 的 PNG、JPEG、WebP、GIF 附件由 Session 纳入视觉输入，在 Provider 边界读取原文件内容，要求模型支持图片输入。journal 保留图片引用，不写入 base64；Host canonical path 不进入消息合同。粘贴长文本仍保存为 Session-owned 只读快照。PDF 仍是 `kind=file`，并由声明 `application/pdf` 激活媒体类型的 Skill 插件处理。

## 打开规则

- 文件不存在或数据库为空时，执行对应的当前建库合同。
- `user_version` 精确等于当前版本时，验证必需表后打开。
- 其他版本一律拒绝；不迁移、不猜测、不轮询、不读取旧根，也不自动删除用户数据。
- 三个 owner 各自解释自己的 `user_version`，不能用一个 store 的版本推断另一个 store。

## 删除与历史边界

删除 Session 是一次 Session aggregate 删除：Catalog 条目、Session archive、Session 私有目录索引关系、Session-owned 文本资源与工作目录和该 Session 的 ToolRecord 一并删除。该 Session 的资源引用随之失效，外部原文件和原目录保留。ToolRecord 不能被普通工具调用任意修改或删除；只有 Host 协调的 Session aggregate purge 可以删除它。

Catalog、Session 与 ToolRecord 三个业务 store 位于 `<data_dir>/agent-runtime/`；同目录还保存 Host 的 Provider 用量报告索引 `provider-usage.sqlite3`，它不替代 Session journal 或 ToolRecord。`root-owner.lock` 仅证明当前 daemon 的配置根所有权。旧目录和旧数据库不属于当前运行合同，不存在只读历史入口。

如果当前数据库出现找不到对应 Session 的孤立 ToolRecord，应保留原始失败并定位生命周期来源；本合同不授权用启动清理、后台扫描或 UI 行为静默删除它们。
