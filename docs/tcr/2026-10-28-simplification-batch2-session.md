# 第二批简化：Session 生命周期读取与测试用途 TCR

用户已授权按审查结果分两批清理完善，每批以基础 CLI 对话确认运行链路。本项实施 Session 生命周期读取的显式返回，并按已确认的“测试用于链路和必要 GUI 产品逻辑”用途，移除固定措辞与同实现自比较门禁。

必要性：

- 子代理决策路由先读取管理状态，再从 statuses 的缓存副作用取得 pending 决策。并发读取可能更新缓存，使 run 与 pending 来自不同读取。本轮让内部生命周期读取返回 revision 和完整 lifecycle，管理视图和决策路由直接使用同一次读取的 run、pendingPlan、pendingApproval、pendingInteractions；缓存只负责增量读取加速。
- prompt-guidance.test.mjs 把英文提示词、工具说明和产品文档逐句锁定。这些断言不证明模型行为，且会阻碍不改变链路和权限语义的文案调整。
- local-agent.test.mjs 的 discovery 断言使用生产代码自身的 agentOperationDefinitions 生成预期值，无法独立判断返回的能力面是否正确。

旧/新不变量：

- 旧：决策路由隐式依赖 statuses 先填充缓存，并假设缓存中的 pending 对应刚刚读取的 run。
- 新：决策路由只使用该次生命周期读取返回的 run 和 pending；后来的缓存更新不改变已有读取结果。
- 保留：journal 的既有轻量增量读取、编辑后重读、身份校验、单调缓存更新与错误传播。关系事实和运行生命周期仍分别来自现有查询，不新增事务快照承诺，不创建 Actor 或 Provider 来完成只读导航。
- 旧：固定英文句子、产品文档短语以及同一 helper 生成的完整返回值必须逐项相等。
- 新：测试检查实际能力选择、成员权限面、运行时别名和稳定核心结构；合法改写提示词与文档措辞不再使测试失败。discovery 使用独立的 action 集合和可用/禁止字段预期。
- 保留：生产提示词、工具声明、权限、Plan/问题/批准行为、请求级能力替换、取消和恢复语义均不改变；不以字符串存在证明模型遵守指令。

测试资产调整：

- prompt-guidance.test.mjs 移除固定句子断言和产品文档读取，保留稳定核心与动态语法隔离、可选工具隐藏、配置别名传递及成员/禁用状态能力面。
- local-agent.test.mjs 保留既有 Host 模型发现链路，改为独立判断 member 返回的操作、模型/预设选择和禁止的 coordinator 字段；保留不得启动子会话、权限拒绝及 Host 请求断言。
- 既有并发状态读取、父子 Plan/问题/批准路由、审批取消和历史恢复测试不删除、不放宽。未新建测试框架或扩大场景矩阵。

验证由主任务统一执行适用的容器检查及本批基础 CLI 对话。本子任务仅实施并核对 diff，尚未执行测试、构建或真实 Provider；不将静态推断描述为已复现的并发故障。结果在实际验证后补充。未提交、未推送。

## 本批实际结果

共享包构建通过；local-agent、agent-wake、prompt-guidance、plugin-activation 共 179 项全部通过。包括现有并发状态读取、子代理决策路由与取消恢复覆盖。

第二批 CLI/TUI/Host/工具进程单任务构建通过。使用本次容器开发产物，经真实 DeepSeek Flash 完成文件读取与同一 Session 追问两轮 CLI 对话；两轮均 completed、退出码 0，临时 Host/状态已释放。回执：`.build-cache/simplification-20261028/batch2-cli.json`。该结果仅证明基础 CLI 链路，不代表原生 GUI、标准包或跨平台验收。
