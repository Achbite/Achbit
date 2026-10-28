# 第一批简化：Kernel 工具装配与测试边界

用户已授权按简化审查分两批清理，测试用于链路和必要 GUI 产品逻辑。

## 变化与必要性

内置工具由 BuiltinToolProvider 一次生成，process 作为 core contribution 进入同一 ToolSelection；删除 CoreToolProvider 与 ManagedShellToolProvider 的两次全量生成再过滤。MCP/container 的 disposer、generation、调用绑定、权限和资源释放保持原责任。

## 旧与新不变量

旧实现通过两个 provider 包装分类；新实现不承诺内部包装数量，只承诺选择的工具、Shell 可用性和 process 的实际可启动 targets 不变。使用已有 process_start_declares_only_installed_execution_targets、文档插件/core process 和 catalog lifecycle 测试验证。

不新增镜像实现测试。验证失败包括未选择工具泄露、process 声明未安装执行目标、原始执行/清理错误丢失。每批执行基础 CLI 对话，实际结果由本轮交付记录，不把 fixture 或源码检查称为真实 Provider 验收。

删除 callable_descriptors_have_executor_bindings 的同一 registrations map 自比；它从未接线实际 Runtime executor，原始输入 canonicalization 与执行链路测试继续保留。内置 Provider 现直接拥有 process，已有目录测试的预期工具集合增加 process，运行级可用集合不变。

## 本批实际结果

容器 cargo fmt 检查通过；local_agent_tool_catalog 11 项、kernel-tools catalog 7 项全部通过。CLI/TUI/Host 构建成功；工具进程首次并行链接因容器内存不足被终止，单任务构建通过。

第一批使用本次容器开发产物，经真实 DeepSeek Flash 完成文件读取与同一 Session 追问两轮 CLI 对话；两轮均 completed、退出码 0，临时 Host/状态已释放。回执：`.build-cache/simplification-20261028/batch1-cli.json`。该结果仅证明基础 CLI 链路，不代表原生 GUI、标准包或跨平台验收。
