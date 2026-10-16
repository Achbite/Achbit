[English](deepseek.md) | [简体中文](deepseek.zh-CN.md) · [DeepCode](../../README.zh-CN.md)

# 在 DeepCode (Achbite) 中使用 DeepSeek

[DeepCode](https://github.com/Achbite/DeepCode) 是采用 MIT 许可证、提供 GUI、TUI 和 CLI 的本地优先编程 Agent。本指南通过 **Responses API** 接入 **DeepSeek V4.1 Flash**，完成项目读取、工具执行和继续对话。

## 1. 安装并打开 DeepCode

在 [DeepCode Releases](https://github.com/Achbite/DeepCode/releases) 下载实际提供的平台包。选择安装包或解压版前，先阅读该版本的平台说明。

| 平台 | 打开 GUI | 解压版终端启动器 |
| --- | --- | --- |
| macOS Apple Silicon | 安装 PKG 后打开 `/Applications/DeepCode-GUI.app`，或打开解压目录中的 `DeepCode-GUI.app`。 | `./DeepCode-CLI.command`、`./DeepCode-TUI.command` |
| Windows x64 | 安装 Windows Setup 后从开始菜单打开，或打开解压版 `DeepCode-GUI.exe`。 | `.\deepcode-cli.bat`、`.\deepcode-tui.bat` |
| Linux x64 / ARM64 | 解压对应架构的程序包，运行 `./DeepCode-GUI`。 | `./deepcode-cli`、`./deepcode-tui` |

程序包包含运行时。Windows 解压版需要 WebView2，Linux GUI 需要 GTK/WebKitGTK。详见[安装说明](../distribution.md)。

从源码构建时，先安装 Docker 和 GNU Make；Windows 使用已启用 Docker 集成的 WSL2。打包 macOS 还需要 Mac 宿主机的 Xcode Command Line Tools、仓库指定的 Rust 工具链和 Node.js。

**在宿主机执行：**

```bash
git clone --branch main https://github.com/Achbite/DeepCode.git
cd DeepCode
# 仅 macOS：打包前执行一次；Windows 和 Linux 跳过。
bash scripts/setup-macos-signing.sh
make shell
```

`make shell` 会构建或更新开发镜像、创建或复用挂载当前源码的容器，并进入容器；macOS 上还会启动原生构建通道。**在容器内**选择对应命令：

| 目标平台 | 构建命令 | 输出目录 |
| --- | --- | --- |
| macOS Apple Silicon | `bash ./build.sh --stage package-macos` | `bin/macos-arm64/` |
| Windows x64 | `bash ./build.sh --stage package-windows` | `bin/win64/` |
| Linux，与容器架构一致 | `bash ./build.sh --stage package-linux` | `bin/linux-x64/` 或 `bin/linux-arm64/` |

构建成功后运行 `exit`，**回到宿主机**打开输出目录中的 GUI 或终端启动器；例如 macOS 执行 `open bin/macos-arm64/DeepCode-GUI.app`。Windows 产物需从 Windows 打开。各平台完整启动命令见[源码构建说明](../../README.zh-CN.md#从源码构建)。

## 2. 保存 DeepSeek 连接与模型

从 [DeepSeek 开放平台](https://platform.deepseek.com/)获取 API Key。

1. 打开 **设置 → 模型与服务 → API 连接**。
2. 打开现有 **DeepSeek** 连接；如果没有，选择 **添加连接 → API 连接**，并将服务设为 **DeepSeek**。
3. 将 API 地址设为 `https://api.deepseek.com`，填写 API Key 并保存。
4. 打开该连接下的模型，或选择 **添加模型**，填写以下配置并点击 **保存模型**：

| 设置 | 值 |
| --- | --- |
| 显示名称 | `DeepSeek V4.1 Flash` |
| 模型 | `deepseek-flash` |
| API 协议 | Responses API |
| 上下文窗口 | `1000000` |
| 最大输出 | `384000` |
| 更多选项 → Thinking | 开启 |
| 更多选项 → 推理强度 | `max` |
| Web search / 联网搜索 | 关闭 |

按照[最新 DeepSeek 模型文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，API 模型名使用 `deepseek-flash`，`DeepSeek V4.1 Flash` 只是显示名称。部分接入示例仍写 `deepseek-v4-flash`，本指南采用上述当前 API 名称。

DeepSeek 官方说明支持 **1M token 上下文**和**最高 384K token 输出**。上表数值是 DeepCode 的 token 预算配置。上下文包含输入与生成输出，最大输出预算不代表必须生成这么多内容。保持 Thinking 开启，并明确保存 `max`；内置预设本身没有将推理强度固定为 `max`。详见[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)。

[Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/) 对 `deepseek-flash` 忽略内置 `web_search`，因此本指南的 Flash 配置将它关闭。同一 API 文档说明 `deepseek-v4-pro` 支持服务端联网搜索，那是另一条模型路径。单独配置的搜索工具有各自的可用条件。

![DeepCode 模型编辑器保存 DeepSeek V4.1 Flash、Responses API 和 Max](../../assets/readme/deepseek-settings-en.png)

*macOS GUI 中已保存的配置，画面没有包含 API Key。*

模型编辑页的 **测试** 只发送一条短连接探测，会消耗 API 用量。探测成功后，继续完成下方真实任务。

## 3. 完成首次任务并继续对话

选择项目文件夹，在会话的模型选择器中选中已保存的 DeepSeek 模型，并将推理强度设为 **`max`**。会话中明确选择的强度优先于模型配置；DeepCode 会记住该模型的选择。

发送：

> 阅读这个项目的 README，说明项目用途、主要入口和运行方法。列出你实际读取的文件，不要修改文件。

然后在同一会话继续发送：

> 阅读一个与刚才入口有关的源码文件，说明它与 README 的关系。使用一个简短代码片段和一张表格，不要修改文件。

审核 DeepCode 显示的访问申请。执行历史会展示实际调用的工具及其结果。第二条消息应保留在同一会话中，以使用前一轮任务的上下文。

## 4. 在 CLI 或 TUI 中复用连接

GUI、CLI 和 TUI 共享已保存的模型连接。通过 macOS PKG 或 Windows Setup 安装后，可以使用 `deepcode-cli`、`deepcode-tui`；Windows 安装后重新打开终端以加载 PATH。解压版请替换为安装表格中的启动器。

```bash
deepcode-cli connections
deepcode-cli --model <profile-id> chat -C /path/to/project
```

从 `connections` 列出的 DeepSeek 模型中复制 `<profile-id>`。它是 DeepCode 保存的配置 ID，不是 API 模型名 `deepseek-flash`。在这次 CLI 对话中依次发送上述两个任务，完成后用 `/quit` 退出。

TUI 启动方式：

```bash
deepcode-tui -C /path/to/project
```

用 `/model` 选择已保存的 DeepSeek 模型，也可以用 `/model <profile-id>` 直接选择。会话没有明确的推理强度覆盖时，使用模型配置中保存的 `max`。用 `/sessions`、`/resume` 打开已有会话，输入 `/` 查看可用命令。详见[终端窗口与字体说明](../distribution.md)。

## 参考

- [DeepCode 模型、连接与用量](model-services.md)
- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)
- [当前模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
