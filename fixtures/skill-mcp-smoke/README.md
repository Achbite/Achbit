# Skill / MCP 链路输入

产品版本和插件使用说明见[项目 README](../../README.zh-CN.md)。本目录随源码发布，不单独声明产品版本。

该目录只保留两项可由测试临时装配的原始输入：

- `skills/text-echo-declarative/SKILL.md` 是纯 instruction contribution；它不授予
  Kernel 工具、工作区、Shell、网络或 secret 权限。
- `mcp/mcp-text-tools/server.py` 是行分隔 JSON-RPC 的本地 stdio MCP Server，提供
  `text.reverse` 工具。测试通过临时设置注册它，Kernel 持有并回收对应进程。

测试应通过结构化 Provider fixture 驱动工具识别和执行，不依赖固定自然语言问句或
关键词。已选 Skill 的内容会在下一次模型请求前重新准备；已选 CLI 插件遵循同一内容更新边界。
已有请求、待审批和运行中的调用保留原 generation 与绑定。CLI 插件注册、Skill 挂载和
MCP 配置在当前运行的下一次模型请求前刷新；模型与执行环境设置在下一次 run 生效。
注册刷新不等于重载外部 MCP 服务代码或替换已有调用的连接。

这些文件不是插件 descriptor、运行时合同、发布清单或第二套事实源。

外部 MCP 注册可以附带 `description` 描述支持的任务，供 `plugin.search` 检索；实际工具仍由选中后的 MCP 服务提供。结构化 Provider fixture 验证发现、激活和执行链路，不证明真实模型会从普通任务自主选择能力。该行为需要使用不包含插件名、工具名或激活步骤的任务另行观察，并记录实际选择。
