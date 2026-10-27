# 插件开发规则

[English](README.md) · [项目 README](../../README.zh-CN.md#插件) · [产品操作说明](../product/operations.md#settings-and-extensions)

[职责边界](#职责边界) · [制品与导入](#制品与导入) · [发现与描述](#发现与描述) · [CLI 工具协议](#cli-工具协议) · [托管服务协议](#托管服务协议) · [UI 与 Skill](#ui-与-skill) · [模型端点的文件与会话](#模型端点的文件与会话) · [验证](#验证)

本文说明现有的通用扩展合同。示例是协议模板，不会加入内置插件目录。符合这些合同的插件以独立文件交付，经设置页导入即可使用，无需逐个增加 Host 接口、模型注册或修改 Agent Loop。

## 职责边界

| 责任方 | 职责 |
| --- | --- |
| Session | 唯一 Agent Loop、上下文装配、Provider 调用、取消、journal 与语义投影。 |
| Kernel | 可调用工具绑定、effect、权限、执行结果和调用尝试拥有的资源。 |
| Host | 制品发现、配置与凭据保存、服务进程托管、事件传输。 |
| 插件 | 实现声明的操作或服务，回收自己创建的资源。 |
| UI | 展示共享事实、采集用户输入。 |

任务装配在模型请求之前选出可调用工具。只读任务只获得读取任务和读取工具；没有装配的可选能力不产生调用绑定，也不以“已关闭的框架功能清单”进入上下文。只有任务具备子代理能力时才加入相关委派指导。上下文精简不替代执行时的权限检查。

托管 Shell、容器和插件激活分别有明确的资源所有者。完成事件主动送到 Session，主对话模型不必反复询问子代理是否完成。关闭 Reader 只释放订阅，不终止子任务。拆除可选能力后，核心 Loop 与剩余工具应继续工作。

## 制品与导入

准备包含清单及运行文件的插件目录，打开 **设置 → 插件 → 添加**，选择 ZIP、目录或具体清单文件。检查只读取描述并验证入口，不执行插件代码。一个目录存在多份受支持清单时，必须选择具体文件。也可以直接选择 ZIP 进行安装或更新。一个 ZIP 只包含一个插件，清单位于压缩包根目录或单层外包目录。Host 临时解压、按相同清单与入口合同检查，再安装自身副本；预览、取消或失败不留下解压安装。ZIP 支持存储/Deflate 压缩，解压后上限 512 MiB，只接受普通文件和目录；清单歧义、非法条目和解压错误会明确报告。

| 类型 | 可识别文件 | 保存位置 | 启动方式 |
| --- | --- | --- | --- |
| CLI 工具 | `achbit-tool.json` | `plugins.sources` | 按任务激活工具贡献，每次调用启动一个进程。 |
| 托管服务 | `achbit-service.json` | `plugins.services` | 启用启动进程，停用或移除回收进程。 |
| 展示插件 | `achbit-ui.json` | `workbench.uiPlugins` | 启用后将模块应用到声明的槽位。 |
| Skill | `SKILL.md` | `skills.mounts` | 按任务选择、读取指导。 |
| 外部 MCP | 在设置页配置服务 | `mcp.servers` | 沿用 MCP 发现和激活，无需新增 Achbit 清单。 |

确认安装后，Host 将制品复制到自身数据目录的 `plugins/packages/<installation-id>`，验证副本后才保存安装路径。之后移动或删除下载/解压目录不会影响已安装插件，也不会将它变成内置插件。MCP 连接继续使用原有配置，不复制远端服务器。

在插件详情中选择 **更新…**，提供同一类型、同一插件 ID 的新制品。Host 先准备新副本，再替换安装路径，保留启用状态；服务停止旧进程后使用原 `stateDirectory` 启动新版。旧制品保留，避免破坏仍引用它的活动任务。安装前的复制或校验失败不切换注册；启动失败保留真实错误，修正后重新启用。旧的直接路径注册可通过这次更新转换为托管副本。移除注册不自动删除插件数据或登录信息。

JSON 清单可声明可选 `files` 数组，例如 `"files": ["entry.mjs", "public", "vendor"]`。每项为制品内的相对文件/目录，不支持 glob、绝对路径和 `..`；所选清单自动包含。未声明时复制完整制品目录；`SKILL.md` 连同所在目录的支持资源复制。请交付整理后的目录，或用 `files` 明确运行所需资源，避免混入账户、开发缓存和测试资料。CLI 的单文件运行合同不变。

逻辑插件 ID 标识插件，不能与安装批次、进程、调用尝试或会话 ID 混用。更新制品不自动授予新的执行权限；ID 或类型改变时作为另一个插件安装。

交付内容包括清单、编译入口、所需资源和依赖。登录数据、API key、状态目录、运行日志和测试对话留在制品之外。仅供实验的服务设置 `debugOnly: true`，正常包会拒绝启动；实验插件不加入内置目录或普通包。

## 发现与描述

`name` 供用户识别插件；`description` 简述可复用能力和适用任务。工具描述说明操作、输入和必要约束。描述应与某个具体任务无关，不写评测问句、预期答案、启停清单、登录状态或框架启动步骤。生命周期状态属于 Host/UI；详细方法放入 Skill 或文档。

`plugin.search` 检索可用工具/Skill 目录，不启动进程。关键词匹配能力描述，不传 query 可浏览目录。`plugin.activate` 使用发现结果中的准确 URI，选择已启用插件并将其贡献加入后续请求。发现、用户启用、任务激活和执行权限是不同动作，激活不等于安装、批准权限或注册模型。UI/服务插件由用户设置管理，服务启动不自动增加模型工具。

本地 CLI 插件的目录 URI 为 `plugin://<id>@cli`。清单工具在 Achbit 中命名为 `<id>.<name>`，插件收到原始局部工具名。使用发现结果里的 URI 和 schema，不猜测实例 ID 或参数。

## CLI 工具协议

`achbit-tool.json` 声明一个单文件构建产物：

```json
{
  "id": "plugin-id",
  "name": "插件名称",
  "description": "说明可复用能力与适用任务。",
  "command": "node",
  "entry": "entry.mjs",
  "args": [],
  "tools": [{
    "name": "operation",
    "description": "说明操作行为与输入合同。",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
  }]
}
```

- `id` 与工具名非空，只允许 ASCII 字母、数字、`.`、`_`、`-`；同一清单中的工具名必须唯一。
- `name`、`description`、`command`、`entry` 和非空 `tools` 必填。`args` 缺省为 `[]`；`inputSchema` 缺省为 `{"type":"object"}`，显式提供时必须是对象。
- `entry` 是目录中的一个文件名，不支持子目录路径。依赖打入该文件；运行时捕获它并复制到本次调用归档。文件大小为 1 字节至 4 MiB，UTF-8 JSON 清单不超过 64 KiB。
- 实际执行为 `command <archived-entry> ...args`，不经过 Shell。`command` 必须是 Host 进程环境可解析的命令或可执行文件绝对路径。CLI 合同不安装依赖，也不保证提供解释器；托管 Node 服务使用下节的独立合同。
- 有工作区绑定时，以工作区为工作目录。不要假设入口仍在原始插件目录中，也不要从原始目录读取相对依赖。

每次调用从 stdin 读取一个 JSON 值直到 EOF：

```json
{"name":"operation","arguments":{},"context":{"achbit":{"outputDirectory":"/absolute/attempt-output"}}}
```

`name`、`arguments` 是操作输入。`context` 是 Host 提供的执行元数据，其中 `context.achbit.outputDirectory` 在存在时表示本次调用的输出目录；`achbit` 是现有协议键名。这些元数据不是系统提示词或模型消息。

向 stdout 输出一个完整 JSON 结果后退出。结构化失败使用 `{"error":{"code":"operation_failed","message":"具体原因"}}`；非零退出、无效 JSON、取消和超时也属于失败。诊断写 stderr。当前上限为 60 秒、stdout 4 MiB、stderr 64 KiB。Host 持有并回收进程树。常驻服务应使用托管服务合同，不应由单次工具调用留下后台进程。

产物登记与最终交付由 Kernel/Session 负责。工具输出一个路径，不等于已经归档或完成交付；需要使用现有资源合同，失败保留原始错误。

## 托管服务协议

`achbit-service.json` 声明 Node 服务。服务使用 Achbit 解析到的 Node 运行时，在自己的源目录运行，依赖可以随入口一起交付。

```json
{
  "schema": "achbit.service-plugin.v1",
  "id": "plugin-id",
  "name": "插件名称",
  "description": "说明服务能力与端点协议。",
  "entry": "entry.mjs",
  "args": [],
  "debugOnly": false
}
```

除 `args`、`debugOnly`、`files` 外均必填；前两者缺省为 `[]`、`false`，`files` 的复制规则见上节。未知字段会被拒绝。ID 长度为 1–128 个 ASCII 字符，以字母或数字开头，其余允许字母、数字、`.`、`_`、`-`。清单不超过 64 KiB。`entry` 必须指向插件目录内已存在的文件，允许相对子目录。

Host 启动 `node <entry> ...args`，向 stdin 写入一行以换行结束的初始化 JSON：

```json
{"protocol":"achbit.service-plugin.v1","stateDirectory":"/absolute/host-owned/plugin-state"}
```

服务成功监听端点后，应在 10 秒内向 stdout 写入一行 ready JSON：

```json
{"protocol":"achbit.service-plugin.v1","baseUrl":"http://127.0.0.1:17632/v1","pageUrl":"http://127.0.0.1:17632"}
```

`pageUrl` 可选。URL 要求 HTTP、`127.0.0.1` 和显式端口，不含凭据、query 或 fragment，可以有路径。ready 行不超过 64 KiB；stdout 专用于握手，诊断写 stderr，由 Host 写入状态目录中的 `runtime.log`。握手或 URL 中不能放凭据。

stdin 出现 EOF 表示 Host 正在关闭服务。停止接收工作，取消进行中的请求，关闭监听和子资源后及时退出。停用、移除、替换来源与 Host 退出都走这一资源所有者链路。Host 给出 1 秒正常退出时间，随后回收其进程树。异常退出会清除端点、保留失败并通知订阅者，不需要有人读取插件列表才发现退出；没有隐式重启循环，解决原因后由用户重新启用。

持久化数据保存在 `stateDirectory`。进程重启保留该目录；移除注册不代表登出或删除凭据。登录/登出及首次启用引导由插件实现：需要登录的插件可以在无已保存凭据时打开自己的登录浏览器，已有登录则复用。Host 不读取第三方账户凭据，也不把凭据混入制品。源码文件和临时 PID 不承担持久化职责。

端点业务协议归插件所有。提供兼容 LLM API 的服务可以像其他本地端点一样填入已有模型连接配置，不改变 Agent Loop，也不注册新的模型类型。API 身份验证与进程生命周期握手分开。

## UI 与 Skill

UI 插件在 `achbit-ui.json` 中声明受支持槽位，以单个独立浏览器 ES module 导出 `default { apply(context) }`，通过 `context.register` 注册渲染器。渲染器消费公开输入和动作，返回 `update`、`dispose`；`apply` 可以返回清理函数。监听器、样式、订阅和异步工作使用作用域内的释放与取消。替换等待旧效果释放，停用恢复内置展示。完整的槽位、capability 与动作合同见 [UI 插件协议](../product/ui-plugins.md)。

Skill 的 `SKILL.md` 包含 `name`、`description` front matter 和 Markdown 指导。配套资源、引用与入口一起交付，使用相对链接，指导聚焦其能力。Skill 不启动常驻服务、不授予权限、不另建 Loop。通过 `skills.mounts` 登记，沿用已有 Skill 读取机制读取正文及资源。

MCP 集成使用 `mcp.servers` 和既有传输。服务描述用于发现，工具 schema 与结果沿用 MCP。CLI 清单、MCP server 和托管服务代表不同的执行生命周期，不能相互混称。

## 模型端点的文件与会话

以下规则仅适用于提供兼容模型端点的插件：

- 在已有模型配置中声明支持的图片和文件输入。`fileInputMediaTypes` 控制原生文件传输，不保证每个文档都被模型完整识别。
- 图片使用 `image_url`；文档在 Chat Completions 中使用带有 `filename`、`file_data`（data URL）的 `file` 内容段。保持原始字节及媒体类型；不支持时明确报错，Host 传输不能静默将文档换成文本或图片。
- 对属于会话的请求，Chat Completions 传输携带 `X-Achbit-Session-Id`、`X-Achbit-Request-Purpose` 请求头。这是传输元数据，不进入模型上下文。插件据此拥有远端会话映射和续接游标，无需修改 Loop。
- 只有客户端保留历史与已确认检查点一致时才复用远端会话，只追加新消息与附件。编辑历史、压缩上下文或新建 Session 可以产生新的远端会话。账号与用途分别隔离；辅助标题请求 `conversationTitle` 不得推进正文会话。不支持该用途时明确返回错误，Host 保留已有首条消息生成的初始标题并记录失败。
- 适配器传递取消并保留上游错误。取消或失败后的未知完成状态不能视为已确认游标，也不能静默重放并当作成功续接。

原生上传与本地文档操作是不同能力。本地 PDF 阅读、导出使用各自插件工具；Documents 的 PDF 导出接收 Typst 源码，由 Rust Typst 编译，HTML/Markdown 分别接收对应格式源码。见[文档输入输出规则](../../skills/achbit-documents/references/formats.md)。网页解析准确性属于上游结果，不能用传输成功证明。

## 验证

使用插件自己的依赖构建入口，再在独立 Achbit Debug 实例导入实际目录或清单。验证发现、一次真实调用或服务握手、停用/移除时的清理；插件拥有异步工作时核对失败与取消。服务应核对端口释放、预期持久化状态能否跨重启保留。使用已有协议的插件不需要额外的平台矩阵或新增模型工具。

修改 Achbit 自身时，使用仓库的[开发与测试入口](../development.md#checks)，测试变更提供 TCR。单元测试、Debug 加载、真实 Provider 对话与发布打包分别记录。UI/服务生命周期验证可使用 [Debug 控制](../debug-control.md)。

源码责任方：[工具清单](../../crates/achbit-kernel-abi/src/tool_plugin.rs)、[服务清单](../../crates/achbit-kernel-abi/src/service_plugin.rs)、[导入检查](../../crates/achbit-host-web/src/ui_plugins.rs)、[CLI 调用](../../crates/achbit-kernel-daemon/src/local_agent_cli.rs)、[工具发现](../../crates/achbit-kernel-daemon/src/local_agent_mcp.rs)、[服务监督](../../crates/achbit-kernel-daemon/src/service_plugins.rs)、[任务激活](../../userspace/session-core/src/local-agent/pluginActivation.ts)。
