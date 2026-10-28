# 第一批简化：插件选择请求 TCR

## 必要性

用户批准分两批清理，并指定测试用于链路与必要 GUI 产品逻辑。`pluginCatalogRevision` 从 GUI/CLI/TUI 经 Session、journal 与 Host 请求传递，但 Host 只反序列化后丢弃，插件实际按 URI 和当前注册解析。旧校验要求非空 `pluginSelections` 必须附带这个无消费者的 revision，造成生产协议及测试 fixture 的重复维护。

## 旧／新不变量与失败边界

- 旧：非空插件选择必须附带合法格式的 `pluginCatalogRevision`，即使它不参与目录匹配或执行。
- 新：请求只携带 `pluginSelections` 的 `selectionId`、`uri`、`label`。保留字段格式、重复 selection/URI、禁用或缺失插件检查；不再要求或接受请求 `pluginCatalogRevision`。
- `selectedPlugins.catalogRevision` 继续保留在运行快照中；`pluginInstanceRef`、`extensionGenerationRef`、`toolBindingRef` 及执行、审批、刷新、退役、释放语义均保持。
- 不新增旧协议兼容路径或旧持久化事件迁移。

## 测试资产调整

- Session `local-agent.test.mjs` 与 `plugin-activation.test.mjs` 的既有激活/排队链路去掉请求 revision fixture，保留激活、后续请求工具可见性、调用身份和运行释放断言。
- Rust kernel-client、共享 CLI/TUI 输入、CLI focus 既有测试随请求 builder 签名去掉无效参数，保留正文、附件、插件选择、focus/reply 和错误行为断言。
- `local-agent-e2e.py` 继续从真实目录选择插件并经 Host 提交，去掉请求 revision 透传，保留目录快照 revision 校验和实际工具链路；`conversation-storage.py` 不再为无插件消息额外读取插件目录。
- 当前协议 schema 同步移除请求/排队 projection 中的字段；不删除任何测试、跳过测试或放宽剩余断言，不为私有实现结构增加测试。

## 验证记录

本子任务只完成源码和测试资产修改。容器检查与第一批基础 CLI 对话由主任务统一执行；本文件不把静态修改声明为运行通过。

## 本批实际结果

共享包构建与 GUI 正式/手工入口类型检查通过；Session local-agent/plugin-activation/runtime-contract 合计 137 项通过。

第一批使用本次容器开发产物，经真实 DeepSeek Flash 完成文件读取与同一 Session 追问两轮 CLI 对话；两轮均 completed、退出码 0，临时 Host/状态已释放。回执：`.build-cache/simplification-20261028/batch1-cli.json`。该结果仅证明基础 CLI 链路，不代表原生 GUI、标准包或跨平台验收。
