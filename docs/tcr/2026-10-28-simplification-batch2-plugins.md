# 第二批简化：Skill 元数据与插件链路 TCR

## 必要性

安装检查与运行目录各自解析同一个 Skill：安装读取 `name:`／`description:`，运行目录忽略这两个字段而选择标题和正文。用户已批准合并这份重复责任，并清理仅搬运字符串、不能证明链路的测试。

## 旧／新语义和失败边界

- Skill 安装 inspection 与运行目录／激活共同读取 artifact owner 的元数据。名称优先使用既有单行 `name:` 规则，缺省使用一级标题，再缺省使用目录名；描述优先 `description:`，缺省使用正文首个说明行，最后使用通用说明。
- 不改变现有名称提取和安装 artifact ID 规则。共享解析返回原始名称，安装 ID 保留原值；运行展示仍单独按现有 160／240 字节界限截断名称和摘要。
- Skill 正文原样传递到 `capabilitySummary`；不引入 YAML 依赖、完整 frontmatter 语法或新的注册方式。不修改 mount ID、插件 URI、instance/generation 身份、权限、错误传播和生命周期。
- 继续保留文件大小、UTF-8、空正文与读取错误的既有处理；不以替代正文制造可用状态。

## 测试资产调整

- 在既有 `unavailable_plugins_preserve_their_errors_without_blocking_selected_skills` 链路测试中加入安装 inspection → 目录 → 搜索 → 选择 → Session 配置的元数据检查。一个输入带 `name`／`description` 且标题与名称不同，另一个使用现有无元数据 Skill，验证合法缺省。断言保留原始 artifact ID、消费者可见字段及完整正文。
- 删除 `plugin-activation.test.mjs` 的 `the actual builtin Computer Use instructions satisfy the Session plugin configuration contract`：它读取 README，但生产加载 AGENT_GUIDE 与平台指导；输入等于 decoder 输出不能证明实际指导链路。同步删除其专用 imports。
- 保留同文件中的激活与显式提及共存、下一 Provider 请求工具可见、真实调用身份、GUI 缺省可用性及运行释放断言。不给说明文字或解析私有函数建立快照测试。

## 验证记录

本子任务未执行构建和测试。主任务统一执行第二批容器聚焦检查与基础 CLI 对话后记录实际结果；源码与测试资产修改不代表运行验收。

## 本批实际结果

容器 Rust Skill/plugin 既有链路测试 6 项全部通过，包含安装 inspection、目录、搜索、选择和 Session 配置的一致性。Session 聚焦测试共 179 项通过，包含保留的插件激活链路。

第二批 CLI/TUI/Host/工具进程单任务构建通过。使用本次容器开发产物，经真实 DeepSeek Flash 完成文件读取与同一 Session 追问两轮 CLI 对话；两轮均 completed、退出码 0，临时 Host/状态已释放。回执：`.build-cache/simplification-20261028/batch2-cli.json`。该结果仅证明基础 CLI 链路，不代表原生 GUI、标准包或跨平台验收。
