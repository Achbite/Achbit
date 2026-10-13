# DeepCode 安装与用户文件

DeepCode 提供图形界面、CLI 和 TUI。三种入口共享模型设置、会话历史和后台服务。运行包包含所需的 Node 和程序资源，无需安装开发工具链。

## macOS

打开 `DeepCode-<version>-macos-arm64.pkg` 完成安装。应用位于 `/Applications/DeepCode-GUI.app`；终端可使用 `deepcode`、`deepcode-cli` 和 `deepcode-tui`，命令安装在 `/usr/local/bin`。

解压版可直接打开 `DeepCode-GUI.app`，或使用同目录的 `DeepCode-CLI.command`、`DeepCode-TUI.command`。移动解压版时应保留这些文件的相对位置。用户文件存放在下表所列目录，与应用位置无关。

macOS 安装包包含 DeepCode-GUI.app 和独立的 DeepCode Computer Use.app。桌面截图与操作由后者执行，需要首次为该辅助 App 授予辅助功能和屏幕录制权限；`computer.control status` 返回实际执行进程。运行 `bash build.sh --stage computer-use` 可单独更新辅助组件，下一次调用前由 GUI、CLI、TUI 共用的 Host 退出旧组件并启动新版，旧观察句柄需重新获取。工具定义和内置指南仍由 Kernel 构建提供。

macOS 更新需持续使用同一签名身份，以保留辅助功能和屏幕录制授权。首次安装或从早期 ad-hoc 构建切换签名身份时，系统可能要求授权一次；日常更新不应通过重置权限完成。本机开发的固定签名设置见[运行管理](product/operations.md#macos-signing)。

## Windows

运行 `DeepCode-<version>-win64-setup.exe`。默认程序目录为 `%LOCALAPPDATA%\Programs\DeepCode`。安装器创建开始菜单入口并添加用户 PATH，重新打开终端后可使用 `deepcode`、`deepcode-cli` 和 `deepcode-tui`。

GUI 需要 WebView2 Evergreen Runtime。Setup 检测到缺失时会下载并运行微软安装器；无法完成时会显示错误。解压版使用同一套用户目录，GUI 入口为 `DeepCode-GUI.exe`，命令入口为 `deepcode-cli.bat` 和 `deepcode-tui.bat`。卸载移除程序和本安装添加的 PATH 项，保留用户文件。

桌面截图与操作由程序目录中的 `DeepCode-Computer-Use.exe` 执行，共享 Host 在首次调用时启动它，并随 Host 退出回收；关闭某个 GUI 窗口不等于结束其他入口的任务。Windows 不需要单独授予辅助功能或屏幕录制权限；以管理员身份运行的程序窗口不能由普通权限的 DeepCode 观察或操作。替换该文件后，下一次调用前 Host 会结束旧组件并启动新版本，旧观察句柄需重新获取。

## Linux

解压后使用包内 `DeepCode-GUI`、`deepcode-cli` 或 `deepcode-tui`。桌面环境需要 GTK 和 WebKitGTK。工作区 Shell 的环境要求见[执行环境](product/execution-environments.md)。

## 用户目录

| 用途 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 配置 | `~/Library/Application Support/DeepCode/config` | `%APPDATA%\DeepCode\config` | `${XDG_CONFIG_HOME:-~/.config}/DeepCode` |
| 持久数据 | `~/Library/Application Support/DeepCode/data` | `%LOCALAPPDATA%\DeepCode\Data` | `${XDG_DATA_HOME:-~/.local/share}/DeepCode` |
| 缓存 | `~/Library/Caches/DeepCode` | `%LOCALAPPDATA%\DeepCode\Cache` | `${XDG_CACHE_HOME:-~/.cache}/DeepCode` |
| 临时文件 | 系统用户临时目录下的 `DeepCode` | `%TEMP%\DeepCode` | 系统临时目录下的 `DeepCode` |
| 日志 | `~/Library/Logs/DeepCode` | `%LOCALAPPDATA%\DeepCode\Logs` | `${XDG_STATE_HOME:-~/.local/state}/DeepCode/log` |

配置目录中的 `user/local/settings` 保存设置和模型配置，`user/local/secrets` 保存本地凭据。持久数据目录中的 `agent-runtime` 保存会话数据库、附件、工具记录和会话工作目录。会话引用的预览、截图和生成文件随会话保留，不属于可清理缓存。macOS Chrome 文件工具使用当前会话已有的私有工作目录作为根和进程工作目录，相对截图路径也落在这里；不把项目或附件目录自动加入根，上游系统临时目录仍保留。

缓存用于可重新生成的内容。macOS WebKit 的网站存储由系统管理，使用其标准 Library 目录。每次 Shell 调用拥有独立临时目录，调用及其子进程结束后清理；需要后续使用的文件应保存到会话工作目录或已授权项目目录。GUI 启动诊断位于日志目录的 `host-startup`，CLI 启动的后台服务日志为 `deepcode-kernel.log`。

可通过 `DEEPCODE_USER_ROOT` 显式指定独立用户根。该模式将 DeepCode 管理的配置、持久数据、缓存、临时文件和日志分别放入所选根下的 `config`、`data`、`cache`、`tmp`、`logs`，同一次使用的各入口应设置相同值。未设置时使用上表的平台默认目录。程序资源位置由应用和启动器自动设置，不需要全局配置内部环境变量。

## 配置准备与备份

安装或首次启动时，DeepCode 创建所需用户目录。macOS 使用实际启动应用的用户目录；Windows Setup 使用当前安装用户的目录。

发现冲突配置时，DeepCode 先将原文件及校验错误保存到持久数据目录的 `config-backups/<记录目录>`，再清除过期权限字段并补齐缺省权限项。不符合当前结构的模型配置恢复为内置模板，之后需在设置中重新配置模型服务。有效权限和其他设置、本地密钥文件及会话数据保留。

有效文件不改写，重复启动不重复备份。损坏 JSON、文件读取失败和无效默认模型选择会保留原错误。备份或写入失败时显示错误；应用正在使用的数据目录不能同时执行安装配置准备。

## 更新与功能配置

更新前结束或取消正在执行的任务，并关闭 DeepCode 的各个入口。若曾用 `deepcode-cli start-host` 启动常驻后台服务，先执行 `deepcode-cli stop-host`，再运行新安装包或替换解压版程序。设置、会话和附件位于用户目录，更新程序不会覆盖这些文件。

| 调整内容 | 生效时机 |
| --- | --- |
| 已启用 UI 插件的编译后入口模块或 manifest | 保存后在当前 GUI 窗口更新；TypeScript 源码需先编译为插件声明的 JavaScript 入口。 |
| 当前运行已选用的 Skill、CLI 插件内容 | 下一次模型请求前重新准备；已有请求、待审批调用和正在执行的调用保留原内容与绑定。 |
| 模型、权限、插件注册和执行环境设置 | 下一次运行生效。 |
| 子智能体委派开关 | 新建或续派任务按最新值准入；关闭不取消已经运行或等待的任务，也不删除历史。 |
| 更新后的 GUI 资源 | macOS 使用 Cmd+Shift+R，其他平台使用 Ctrl+Shift+R 重载界面。 |
| Session、Kernel、原生程序或内置产品说明 | 安装对应构建产物并重启相关进程，修改源码不会直接更新运行中的程序。 |

Skill、CLI 插件及运行设置的生效边界适用于 GUI、CLI 和 TUI；UI 插件仅影响图形界面。完整程序更新后重新打开 DeepCode。详见[插件说明](product/ui-plugins.md)和[模型服务](product/model-services.md)。

PDF 阅读使用包内 Web 阅读器，不需要安装 Python。PDF 导出需要可用的 WeasyPrint Python 环境，可在设置中指定 Python 路径。
