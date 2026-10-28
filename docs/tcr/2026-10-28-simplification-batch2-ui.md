# 第二批简化：GUI 文本投影内聚与产品断言 TCR

第一批基础 CLI 对话通过后，按用户确认的两批简化方案实施本批。范围为 GUI 独占的 presentation-core 包内聚及报告指出的两处结构断言收口；不更改 Session 投影、UI 插件生命周期或实际 GUI 产品行为。

## 修改必要性

presentation-core 只有一个纯函数，唯一生产消费者为 GUI。保留独立 workspace 包会额外维护构建、类型引用、依赖和清理列表。将原函数原样移入 GUI 的 presentation/projectCommittedText.ts，既有测试需要从真实 GUI 模块加载它，而不再依赖已删除包的 dist。

settings-layout 的通用标签禁令和 debug-control 的精确 button/span 相邻串锁定了 HTML 实现；这些约束不等于设置保存、过程展开或耗时展示的产品合同。按已批准报告收敛断言，不修改生产组件来迎合测试。

## 旧／新不变量

- 旧：文本投影必须从独立 presentation-core 构建输出加载；构建链路 fixture 要求生成该包。
- 新：GUI 内部函数消费 Session 事实；既有两项测试仍验证 user/assistant/narrative 文本选择、plain/markdown 格式、displayContent 展示及原始事实不改写。构建 fixture 仅更新仍需独立构建的 protocol/session-core 包列表。
- 旧：设置页不得出现 h3/hr/p 标签或特定来源 class；耗时必须由紧邻 button 的 span 渲染且不能使用 details。
- 新：设置页继续验证八个页面及默认 General、字段归属、搜索入口、桌面音频能力、无第二次保存／重置动作、真实错误显示和重新打开行为；HTML 包装标签不是通过条件。
- 新：耗时文案只能出现一次，来自已有测量；过程展开按钮保持可用且完成后折叠，耗时位于过程展开入口之后、回答之前，消息锚点顺序和无新增 footer 保持。标签名、CSS class 和按钮后的精确相邻串不再是通过条件。

## 保留与调整边界

不删除测试用例、不跳过任何用例、不新增测试框架；只调整所述导入、构建 fixture 包列表和实现绑定断言。保留原函数的文本处理、原始 content、展示 content、缓存调用点与 UI 插件 slot 行为。第三方依赖及版本不变，锁文件只移除被内聚包的 workspace importer 和 GUI link。

## 验证安排与结果

主代理统一在项目容器中更新锁文件并执行既有检查、聚焦测试和本批基础 CLI 对话。本 TCR 创建时仅完成修改，尚未运行本批检查；实际结果由批次回执记录，不据此声明 GUI 原生运行、跨平台或发布验收。

## 本批实际结果

GUI 正式/手工入口类型检查与前端构建通过；session-contract、settings-layout、debug-control 共 163 项全部通过。锁文件仅删除旧包 link/importer 的 13 行，第三方版本不变，frozen-lockfile 离线安装验证通过。首次 lockfile-only 离线解析因缺少既有包 registry 元数据未完成，随后直接清除两个失效 workspace 记录并用冻结模式验证。

第二批 CLI/TUI/Host/工具进程单任务构建通过。使用本次容器开发产物，经真实 DeepSeek Flash 完成文件读取与同一 Session 追问两轮 CLI 对话；两轮均 completed、退出码 0，临时 Host/状态已释放。回执：`.build-cache/simplification-20261028/batch2-cli.json`。该结果仅证明基础 CLI 链路，不代表原生 GUI、标准包或跨平台验收。
