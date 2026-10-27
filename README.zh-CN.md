<p align="center">
  <img src="assets/brand/ac-mark.png" alt="Achbit AC 图标" width="144">
</p>
<p align="center">
  <a href="https://github.com/Achbite/Achbit/releases">下载</a> ·
  <a href="docs/product/deepseek.zh-CN.md">DeepSeek 接入</a> ·
  <a href="examples/README.zh-CN.md">示例</a> ·
  <a href="README.md">English</a>
</p>

# Achbit

Achbit 是一个本地优先的编程 Agent，提供桌面 GUI、TUI 和 CLI。在同一个会话中阅读和修改项目、运行命令、操作浏览器，再检查实际结果。

连接你选择的模型服务，通过 Skill、CLI 工具、MCP 和插件扩展能力。**AC** 图标取意于编程竞赛中的 “Accepted”。

[快速开始](#快速开始) · [Computer Use](#computer-use) · [终端](#终端) · [插件](#插件) · [结构](#结构) · [构建](#从源码构建) · [文档](#文档)

## 快速开始

在 [Releases](https://github.com/Achbite/Achbit/releases) 下载对应平台的程序包。

| 平台 | 启动 Achbit |
| --- | --- |
| macOS Apple Silicon | 安装 `.pkg` 后打开 `/Applications/Achbit.app`，或打开解压版中的 `Achbit.app`。 |
| Windows x64 | 运行 Setup 安装器，或打开 ZIP 解压目录中的 `Achbit.exe`。 |
| Linux | 解压对应架构的程序包，运行 `./Achbit`。 |

1. 打开 **设置 → 模型与服务**，添加 API 连接或受支持的订阅。[DeepSeek 配置 →](docs/product/deepseek.zh-CN.md)
2. 选择项目文件夹和模型。
3. 发送任务：**“阅读本项目的 README，说明代码入口，并引用你实际读过的文件。”**

![Achbit 项目、会话与工作区](assets/readme/achbit-workspace.png)

左侧管理项目与会话；工具结果保留在对话中，文件和浏览器预览可以在旁边打开。

程序包包含运行时。WebView2、Linux 桌面依赖和各版本提供的平台包见[安装与平台要求](docs/distribution.md)。

从 0.6.61 起，应用数据目录、环境变量和集成标识统一使用 Achbit 名称。默认首次启动使用新数据目录，旧数据和凭据保留原处，不自动导入。自定义启动器或集成请参阅[数据目录说明](docs/distribution.md#产品标识与数据目录)。

## Computer Use

从代码继续走到实际界面。Achbit 可以在内置浏览器中打开项目页面、观察内容、操作控件并截取结果，也可以通过 Chrome DevTools MCP 或 macOS / Windows 原生桌面工具与应用交互。

试试 **[发布清单](examples/launch-checklist/README.zh-CN.md)** 示例项目：一个包含四项任务、筛选和进度保存的 HTML 页面，无需安装依赖或启动服务器。

> 在内置浏览器中打开 index.html，勾选两项任务，确认 2 / 4 和 50%，筛选已完成项目，然后重载，检查勾选是否保留。

将 `examples/launch-checklist` 打开为项目，使用其中的[完整提示词](examples/launch-checklist/README.zh-CN.md)。要体验从查资料到生成作品的完整任务，可继续尝试 [DeepSeek 浏览器调研示例](examples/deepseek-browser-checklist/README.zh-CN.md)。

支持的平台、入口和权限见 [Computer Use](plugins/computer-use/README.md) 与 [Chrome 接入](plugins/chrome-devtools/README.md)。

## 终端

通过 macOS PKG 或 Windows Setup 安装后，可以运行：

```sh
achbit-cli connections
achbit-cli --model <profile-id> chat -C /path/to/project
achbit-tui -C /path/to/project
```

从 `connections` 复制保存的模型配置 ID。TUI 中使用 `/model` 选择模型，使用 `/sessions` 继续已有会话。GUI、TUI 和 CLI 共享连接与 Session 状态。解压版启动器见[分发说明](docs/distribution.md)。

## 插件

打开 **设置 → 插件 → 添加**，选择外部插件 ZIP、目录或清单文件。Achbit 能识别 CLI 工具（`achbit-tool.json`）、托管服务（`achbit-service.json`）、展示模块（`achbit-ui.json`）与 Skill（`SKILL.md`）；MCP 服务沿用已有 MCP 设置。ZIP 由 Host 自动解压、验证并安装，可直接用于导入或更新。

插件遵循共享的发现、调用和资源释放协议。托管服务随启用启动，停用后释放进程和端口；兼容模型端点仍通过普通模型连接配置使用。任务工具与上下文在请求前装配，可选能力独立于主 Loop。

完整的制品布局、清单字段、stdin/stdout 合同、生命周期、文件传输和验证规则见 **[插件开发文档](docs/plugins/README.zh-CN.md)**，另有 [English version](docs/plugins/README.md)。文档说明通用扩展协议，实验插件不会因此加入内置目录。

## 结构

| 组成 | 职责 |
| --- | --- |
| [Session](userspace/session-core) | 统一 Agent Loop，负责模型轮次、上下文、等待、取消和会话历史。 |
| [Kernel](crates/achbit-kernel-runtime) | 工具执行、权限、结果与资源生命周期。 |
| [GUI](userspace/gui)、[TUI](shells/tui)、[CLI](shells/cli) | 基于共享 Session 投影提供交互界面。 |
| [插件](plugins)与 Skill | 按任务发现和加载能力。 |

文件操作在依赖允许时并行执行；长命令保留运行状态，需要其结果的后续工作等待实际完成。Computer Use 也使用这套工具与会话生命周期。

## 从源码构建

安装 Docker 和 GNU Make。Windows 使用已启用 Docker 集成的 WSL2。macOS 原生打包还需要 Xcode Command Line Tools、仓库指定的 Rust 工具链和 Node.js。

在宿主机执行：

```sh
git clone https://github.com/Achbite/Achbit.git
cd Achbit
# 仅 macOS，首次构建前执行：
bash scripts/setup-macos-signing.sh
make shell
```

`make shell` 会在进入容器前自动检查并更新开发镜像。Dockerfile、入口脚本或镜像构建参数发生变化时，Docker 仅重建受影响的层，其余层直接复用缓存，无需另记镜像更新命令。

Windows 和 Linux 跳过签名命令。在容器内执行：

```sh
bash ./build.sh           # 生成开发宿主平台的可运行程序
bash ./test.sh required  # 标准检查
```

回到宿主机，打开 `bin/macos-arm64`、`bin/win64` 或对应 Linux 目录中的程序。需要压缩包和安装器时，执行 `bash ./build.sh --stage package`。单个平台、Debug 构建及验证说明见[开发指南](docs/development.md)。

## 文档

- [模型、订阅与用量](docs/product/model-services.md)
- [会话、设置与扩展](docs/product/operations.md)
- [插件开发与协议](docs/plugins/README.zh-CN.md)
- [工作区环境与权限](docs/product/execution-environments.md)
- [安装、更新与本地数据](docs/distribution.md)
- [示例项目](examples/README.zh-CN.md)

项目文件和会话记录保存在本地。提示词、选定的上下文和图片会发送给你配置的模型服务；已连接的工具也可能与各自服务通信。

## 许可证

[MIT](LICENSE)。[致谢](ATTRIBUTION.md) · [第三方声明](THIRD_PARTY_NOTICES.md) · [引用信息](CITATION.cff)
