# 正文可交互预览 TCR

用户于 2026-10-28 确认实施 GUI 正文交互预览，并要求在独立 Debug 包中简单实测正文交互、滚动状态保持和侧栏预览，保护缓存命中，不扩大为新的工具或通用前端运行框架。

必要性：现有 Markdown 只能展示 HTML 源码；静态 HTML Reader 禁用脚本。新增显式预览入口和 iframe 生命周期需要验证它与普通代码、链接、静态 Reader 的分界，以及虚拟列表不会立即销毁最近使用的交互状态。

新增 `userspace/gui/tests/interactive-preview.test.mjs`，沿用现有 Node/Vite GUI 合同入口，不修改、跳过或放宽既有测试：
- 明确引用只接受已归档 HTML；普通 HTML 代码、普通链接和文档内的代码引用保持原展示。缺失、live 或错误类型保持真实错误。
- 未稳定的流式预览先等待，稳定块至最终消息沿用同一 block key 和树；交互与静态 Reader 页签身份区分。
- 最近使用的四个预览行跨过普通卸载期限仍保留，后续预览按最近使用顺序释放旧行；普通行及已有焦点规则沿用原合同，断开清理定时工作。

实现范围：GUI Markdown 入口、交互组件、Reader 的展示选项、虚拟行有界保留；按需文档指引。复用 artifact.prepare/present/read，无新增模型工具、Loop 修改、Session 持久化结构或动态系统提示。界面交互只影响 GUI 状态。

计划验证：容器 GUI 既有测试与类型检查，现有 Debug 打包入口；独立 macOS Debug 使用真实会话制品检查按钮/输入、滚动离开并返回及侧栏交互。实际结果及首次有意义的失败在完成后填写。

首次容器检查：GUI 311 项中 304 项通过、7 项失败，类型检查同时定位到新 helper 与组件文件仅大小写及扩展名不同，macOS 挂载下扩展名自动解析误选 helper，导致组件导出未找到。已将 helper 明确改名为 interactivePreviewFrame.ts，保留全部旧测试和断言后复验。

GUI 复验：311/311 通过，GUI typecheck 与 manual typecheck 通过。第一版 macOS Debug 打包成功；真实 DeepSeek 会话暴露随包 Skill 资源未登记，新指南返回 skill_resource_not_found。补齐既有 ProductSkill references，并向既有 product_skills_keep_their_read_only_resources 的资源列表添加该指南，检查资源登记包含该指南。此为按需文档装配修复，不新增工具或改变 Session 合同。保留首次会话回执，取消该定向测试后重新构建。


2026-10-28 实测回执：

- 补齐资源登记后，容器 `cargo test -p achbit-kernel-daemon product_skills_keep_their_read_only_resources` 为 1 passed；未重复扩大测试矩阵。
- 第一版 Debug 构建时间为 2026-10-28T08:38:37Z，已包含本轮全部 GUI 代码。真实 DeepSeek 会话 `session:42bed3b8470ac06df551194c8256a018` 完成 artifact.prepare / artifact.present，最终 Session journal 的 `run.settled` 为 completed。只在后续资源登记中改动了 Kernel 的内置 Skill 引用表。
- 正文计数、名称输入、标签切换均取得 observed 回执并做截图检查。移走 iframe 焦点、滚至会话底部，等待 35 秒后读取仍为同一名称与计数，返回预览保持。该运行场景证明当前对话的离屏往返；四行保留和 LRU 释放边界由前述聚焦合同测试覆盖。
- 同一归档 HTML 可在侧栏交互；正文和侧栏各自保存临时状态。左右侧栏各自收起/展开的定向操作没有重置已操作的状态。
- 曾在交错操作期间观察到两次整块会话界面重新挂载，正文/侧栏随之回到初始值。用户反馈只操作过侧栏；后续按左右侧栏收放定向操作未复现。保留现象，不归因为普通离屏卸载，也不声称已修复该未定位现象。
- 界面交互前后 Provider 的 8 条 records 和 totals 完全一致，没有新增模型请求。本次实现未修改 Loop、Provider 声明或系统提示前缀；按需指南只通过现有 Skill 读取。
- 用户反馈正文右侧似被裁切后，读取最终 message.committed 的原始内容并逐段对照 GUI：原文为 32 个独立段落，每段 40–42 字符，全部以句号结束，32 段在界面文本中完整存在；窄正文宽度下自然换行。截图的右侧留白来自原文分段，不据此改动对齐和布局。这些段落是本轮为滚动检查要求模型生成的测试内容。
- 第一轮后台/离屏动作出现 debug_observation_incomplete（frame-not-observed），虽然控件值已改变，但不作为完整视觉通过；移至前台、预览可见后获取完整 observed 回执。没有盲目重放部分成功动作。
- 后续完整 Debug 重打包在现有开发证书签名阶段返回 errSecInternalComponent；宿主环境中对临时副本、使用同一证书也复现。用户确认没有系统提示。未改变证书、钥匙串或签名策略，第一版签名包保持原状。新增指南引用的 Rust 聚焦检查通过，但包含该登记的完整新版包尚未成功签出，不能把旧包 GUI 实测当成该指南的随包实测。

截图保存于本任务 `inline-preview-debug/inline-interaction.png`、`inline-and-sidebar.png`；正文对照保存为 `body-render-comparison.json`。实现与实测阶段未执行提交、推送或发布操作；后续按用户指令另行分组提交并调整版本号。

资源收尾：独立 Debug stop 返回 cleanupComplete=true；本轮 state（含临时凭据副本）和 workspace 已删除，保留非凭据回执与截图，标准实例未处理。
