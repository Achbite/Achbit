# 第一批简化：标题与设置来源通路 TCR

用户已授权按简化报告分两批实施，本项属于第一批：会话标题统一由 catalog 通路更新，删除没有产品消费者的设置来源派生链。每批进行基础 CLI 对话验证；不扩大为全面 GUI 或平台验收。

## 修改必要性

原 `session-contract.test.mjs` 的两项标题测试把 `/conversation/statuses` 携带标题固定为必需实现。当前 Host 的手动及生成标题都经 catalog 提交并发布变更，GUI 已持续订阅 catalog；继续保留旧断言会强迫维护第二条标题传输、合并与竞态处理路径。

设置来源 `overriddenKeys` 在 Host 恒为空，GUI 的 `sources` 无生产消费者。相关 fixtures 继续模拟这些字段，会使已删除接口留在测试材料中。删除这些字段不能影响持久设置、运行配置、生效时序和原始错误。

## 旧／新不变量与覆盖

- 旧：标题通过 statuses 刷新，GUI 将 statuses.title 归并进 catalog，并阻止旧状态响应覆盖手动改名。
- 新：标题从 catalog 快照及其 ready/change 事件读取；生成标题更新不要求 Session revision 改变，轻量 statuses 只承载 run/revision。`catalog-events.test.mjs` 现有事件测试增加同一 Session 的标题变更场景，继续验证当前投影、选择和草稿视图不被改变。
- 保留：现有 catalog 测试继续覆盖手动改名期间的外部通知、迟到快照不能倒退新 catalog、读取与订阅错误保留、显式重试和最后卸载时释放连接。现有 statuses 测试继续覆盖真实运行状态与独立错误。
- 删除：`session-contract.test.mjs` 中两项绑定 statuses-title 的旧测试，其产品保证由上述 catalog 链路测试承接；不维护字段已删除后的兼容入口。
- 设置 fixtures 删除 `overriddenKeys` 和 `sources`。`context-settings.test.mjs` 沿既有保存／重新加载链路，将 saved settings 与 runtimeSettings 分开，验证保存后待生效状态保留，只有 Host 返回已激活配置时才清除。保留设置默认值、重置、自动保存顺序、错误显示与原有实际配置读回。

## 通过／失败边界

标题在 Session revision 不变时仍应更新；手动改名不得被迟到请求覆盖；catalog 流断开不得被普通快照读取伪装为恢复。设置保存与运行中配置仍须区分，失败不得替换为默认成功。移除的来源标签和 statuses-title 字段不再是通过条件。

## 验证安排与结果

主代理统一执行仓库容器内的既有检查和聚焦测试，并完成本批基础 CLI 对话。此 TCR 创建时仅完成源码及测试调整，尚未运行测试、构建或真实 CLI；实际结果由批次回执记录，不据此声明 GUI 或发布验收。

## 本批实际结果

GUI 正式/手工入口类型检查通过；session-contract/catalog-events/context-settings/settings-autosave/settings-layout 合计 170 项通过。

第一批使用本次容器开发产物，经真实 DeepSeek Flash 完成文件读取与同一 Session 追问两轮 CLI 对话；两轮均 completed、退出码 0，临时 Host/状态已释放。回执：`.build-cache/simplification-20261028/batch1-cli.json`。该结果仅证明基础 CLI 链路，不代表原生 GUI、标准包或跨平台验收。
