# Achbit 安装与用户文件

Achbit 提供图形界面、CLI 和 TUI。三种入口共享模型设置、会话历史和后台服务。运行包包含所需的 Node 和程序资源，无需安装开发工具链。

## macOS

主程序支持 macOS 12 及以上；桌面截图与操作要求 macOS 15.2 及以上。macOS 12–15.1 会在启用桌面控制前显示版本要求，聊天、文件工具和浏览器工具继续可用。

打开 `Achbit-<version>-macos-arm64.pkg`，安装到当前用户。应用位于 `~/Applications/Achbit.app`，终端命令 `achbit`、`achbit-cli` 和 `achbit-tui` 位于 `~/.local/bin`。将 `export PATH="$HOME/.local/bin:$PATH"` 加入所用 Shell 的启动文件后重新打开终端。应用目录由当前用户写入，自动更新无需管理员权限。

解压版可直接打开 `Achbit.app`，或使用同目录的 `Achbit-CLI.command`、`Achbit-TUI.command`。移动解压版时应保留这些文件的相对位置。用户文件存放在下表所列目录，与应用位置无关。

macOS TUI 默认使用 GUI“外观 → 字体详情 → 终端与代码”的有效选择。双击 `Achbit-TUI.command` 时复用 Terminal 已打开的窗口；正常退出后，该专用窗口在 Shell 结束时自动关闭。若在普通终端手动执行 `.command`，退出时恢复该标签原来的字体和标题并返回 Shell。在终端执行安装后的 `achbit-tui` 则新开专用窗口，正常退出后自动关闭。窗口包含其他标签或进程时会保留；启动失败和非零退出保留诊断窗口。其他终端窗口和默认配置不变。

输入 `/font` 查看四套内置字体及系统默认选项，`/font compact` 等命令只切换当前窗口，`/font follow` 重新读取 GUI 选择。内置终端版本保持英文一格、中文两格；自定义终端字体须为固定字宽。首次使用可能需要允许启动器控制 Terminal，拒绝时显示原始错误；启动诊断区分字体准备、窗口创建、字体应用和 TUI 首帧确认。`achbit-tui --in-place` 保留在当前终端运行，管道、帮助和 `--smoke` 也不打开新窗口，这些方式使用原终端字体。更多命令与阅读规则见[产品指南](product/operations.md#reading-and-appearance)。

macOS 安装包包含 `Achbit.app`，内部 `Contents/Helpers/Achbit Computer Use.app` 保持独立签名和执行进程（显示名称为 Achbit Computer Use）。整包更新会一起替换主程序、辅助 App 和运行资源。桌面截图与操作由后者执行，需要首次为该辅助 App 授予辅助功能和屏幕录制权限；`computer.control status` 返回实际执行进程。运行 `bash build.sh --stage computer-use` 可单独更新辅助组件，下一次调用前由 GUI、CLI、TUI 共用的 Host 退出旧组件并启动新版，旧观察句柄需重新获取。工具定义和内置指南仍由 Kernel 构建提供。

macOS 更新需持续使用同一签名身份，以保留辅助功能和屏幕录制授权。首次安装或从早期 ad-hoc 构建切换签名身份时，系统可能要求授权一次；日常更新不应通过重置权限完成。授权保留与系统的“继续允许”提醒是两件事：当前外部窗口采用直接捕获，macOS 仍可能再次提醒，不能据此断言签名失效或重新申请了首次授权。本机开发的固定签名设置见[运行管理](product/operations.md#macos-signing)。

## Windows

运行 `Achbit-<version>-win64-setup.exe`。默认程序目录为 `%LOCALAPPDATA%\Programs\Achbit`。安装器创建开始菜单入口并添加用户 PATH，重新打开终端后可使用 `achbit`、`achbit-cli` 和 `achbit-tui`。

GUI 需要 WebView2 Evergreen Runtime。Setup 检测到缺失时会下载并运行微软安装器；无法完成时会显示错误。解压版使用同一套用户目录，GUI 入口为 `Achbit.exe`，命令入口为 `achbit-cli.bat` 和 `achbit-tui.bat`。卸载移除程序和本安装添加的 PATH 项，保留用户文件。

桌面截图与操作由程序目录中的 `Achbit-Computer-Use.exe` 执行，共享 Host 在首次调用时启动它，并随 Host 退出回收；关闭某个 GUI 窗口不等于结束其他入口的任务。Windows 不需要单独授予辅助功能或屏幕录制权限；以管理员身份运行的程序窗口不能由普通权限的 Achbit 观察或操作。替换该文件后，下一次调用前 Host 会结束旧组件并启动新版本，旧观察句柄需重新获取。

Windows TUI 默认打开专用控制台，读取 GUI“外观 → 字体详情 → 终端与代码”的字体和代码字号。`/font` 切换四套内置字体或系统等宽字体，`/font follow` 重新读取 GUI 选择；`--font compact` 可指定启动字体。正常退出后关闭专用窗口，失败时保留诊断并等待 Enter。`--in-place`、管道、帮助和 `--smoke` 在当前终端运行并保留其字体。内置字体为当前登录会话加载；自定义字体须已安装、固定字宽且能被 Windows 控制台识别，无法应用时显示原因。

## Linux

需要自动更新时，下载与架构对应的 `.AppImage`，放在当前用户可写的目录并赋予执行权限，然后直接运行。附加 `--cli` 或 `--tui` 可启动对应终端入口。保留的 tar.gz 解压版使用包内 `Achbit`、`achbit-cli` 或 `achbit-tui`，通过手动替换更新。桌面环境仍需要 GTK、WebKitGTK 和 ALSA（`libasound2`，用于完成提示音）；AppImage 是程序更新单元，不包含整套系统桌面库。工作区 Shell 的环境要求见[执行环境](product/execution-environments.md)。

## 用户目录

| 用途 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 配置 | `~/Library/Application Support/Achbit/config` | `%APPDATA%\Achbit\config` | `${XDG_CONFIG_HOME:-~/.config}/Achbit` |
| 持久数据 | `~/Library/Application Support/Achbit/data` | `%LOCALAPPDATA%\Achbit\Data` | `${XDG_DATA_HOME:-~/.local/share}/Achbit` |
| 缓存 | `~/Library/Caches/Achbit` | `%LOCALAPPDATA%\Achbit\Cache` | `${XDG_CACHE_HOME:-~/.cache}/Achbit` |
| 临时文件 | 系统用户临时目录下的 `Achbit` | `%TEMP%\Achbit` | 系统临时目录下的 `Achbit` |
| 日志 | `~/Library/Logs/Achbit` | `%LOCALAPPDATA%\Achbit\Logs` | `${XDG_STATE_HOME:-~/.local/state}/Achbit/log` |

配置目录中的 `user/local/settings` 保存设置和模型配置，`user/local/secrets` 保存本地凭据。持久数据目录中的 `agent-runtime` 保存会话数据库、附件、工具记录和会话工作目录。会话引用的预览、截图和生成文件随会话保留，不属于可清理缓存。macOS 和 Windows 的 Chrome 文件工具使用当前会话已有的私有工作目录作为根和进程工作目录，相对截图路径也落在这里；不把项目或附件目录自动加入根，上游系统临时目录仍保留。

缓存用于可重新生成的内容。macOS WebKit 的网站存储由系统管理，使用其标准 Library 目录。每次 Shell 调用拥有独立临时目录，调用及其子进程结束后清理；需要后续使用的文件应保存到会话工作目录或已授权项目目录。GUI 启动诊断位于日志目录的 `host-startup`，CLI 启动的后台服务日志为 `achbit-kernel.log`。

可通过 `ACHBIT_USER_ROOT` 显式指定独立用户根。该模式将 Achbit 管理的配置、持久数据、缓存、临时文件和日志分别放入所选根下的 `config`、`data`、`cache`、`tmp`、`logs`，同一次使用的各入口应设置相同值。未设置时使用上表的平台默认目录。程序资源位置由应用和启动器自动设置，不需要全局配置内部环境变量。

## 配置准备与备份

安装或首次启动时，Achbit 创建所需用户目录。macOS 使用实际启动应用的用户目录；Windows Setup 使用当前安装用户的目录。

发现冲突配置时，Achbit 先将原文件及校验错误保存到持久数据目录的 `config-backups/<记录目录>`，再清除过期权限字段并补齐缺省权限项。不符合当前结构的模型配置恢复为内置模板，之后需在设置中重新配置模型服务。有效权限和其他设置、本地密钥文件及会话数据保留。

有效文件不改写，重复启动不重复备份。损坏 JSON、文件读取失败和无效默认模型选择会保留原错误。备份或写入失败时显示错误；应用正在使用的数据目录不能同时执行安装配置准备。

## 更新与功能配置

从 0.6.63 起，本地 GUI 启动后检查新版本，运行期间每 30 分钟再次检查。SSH 和仅连接外部 Host 的窗口不负责安装更新，更新本地程序前应先关闭这些窗口。新版本从 GitHub Releases 下载并验证更新签名；通过验证后，等待所有任务、审批和后台工作结束，其他使用同一程序的入口关闭，且没有未保存的设置或最近 15 秒的输入活动，再自动安装并重启。未发送草稿和当前视图在重启后恢复。GUI 未运行时不会在后台自行唤起；下次启动再检查。

0.6.62 及以前的客户端没有更新器，需要手动安装一次包含更新器的新版。macOS 新包安装到 `~/Applications`；旧 `/Applications` 副本和旧命令不会被自动删除，应从新路径启动，并确认终端 PATH 优先使用 `~/.local/bin`。两处程序使用相同的用户数据目录，勿同时打开两份程序。

若曾用 `achbit-cli start-host` 启动常驻后台服务，自动更新会等待它退出；执行 `achbit-cli stop-host` 后继续。手动运行安装器或替换解压版程序前，也应结束任务并关闭各入口。设置、会话和附件位于独立用户目录，程序包不包含或覆盖这些文件。下载、签名或安装失败会显示原始错误，可重新检查。

| 调整内容 | 生效时机 |
| --- | --- |
| 已保存的 GUI 字体、字号、配色 | 立即应用于 GUI；已有 macOS TUI 专用窗口用 `/font follow` 重新读取字体，新窗口启动时读取。 |
| 已启用 UI 插件当前安装路径内的编译入口或 manifest | 保存后在当前 GUI 窗口更新；修改原始源码目录后，须通过插件“更新”重新安装。TypeScript 源码需先编译为插件声明的 JavaScript 入口。 |
| 当前运行已选用的 Skill、CLI 插件内容 | 下一次模型请求前重新准备；已有请求、待审批调用和正在执行的调用保留原内容与绑定。 |
| CLI 插件注册、Skill 挂载、MCP 配置和工具插件启停 | 当前运行的下一次模型请求前刷新；已发出的调用保留原绑定。 |
| 模型、权限默认值和执行环境设置 | 下一次运行生效。 |
| 子智能体委派开关 | 新建或续派任务按最新值准入；关闭不取消已经运行或等待的任务，也不删除历史。 |
| 更新后的 GUI 资源 | macOS 使用 Cmd+Shift+R，其他平台使用 Ctrl+Shift+R 重载界面。 |
| TUI 二进制、内置终端字体或原生启动脚本 | 更新对应平台程序包并重新打开 TUI；GUI 重载不替换正在运行的 TUI。 |
| Session、Kernel、原生程序或内置产品说明 | 安装对应构建产物并重启相关进程，修改源码不会直接更新运行中的程序。 |

Skill、CLI 插件及运行设置的生效边界适用于 GUI、CLI 和 TUI；UI 插件仅影响图形界面。完整程序更新后重新打开 Achbit。详见[插件说明](product/ui-plugins.md)和[模型服务](product/model-services.md)。

PDF 阅读使用包内 Web 阅读器和本地 Rust PDF 插件。Documents 插件的 PDF 导出使用包内 Rust Typst 渲染器，输入为自包含 Typst 源码；HTML 和 Markdown 导出保持原格式。用户无需安装或配置 Python。

## 产品标识与数据目录

当前产品名称为 Achbit，主程序为 `Achbit.app` / `Achbit.exe` / `Achbit`，图标为 AC。新构建的命令为 `achbit`、`achbit-cli`、`achbit-tui`。macOS 解压包提供 `Achbit-CLI.command` 和 `Achbit-TUI.command`，Debug 控制使用 `achbit-debug`。Computer Use 辅助程序为 `Achbit Computer Use.app` / `Achbit-Computer-Use.exe`。

从 0.6.61 起，用户目录、Debug 数据目录、环境变量、通信协议、系统应用标识和默认本地签名名称统一使用 Achbit。默认首次启动使用上表中的新目录，不查找、导入或迁移旧产品数据；已有磁盘数据和凭据不删除。自定义启动脚本、远端 Host 与外部集成应使用当前的 `ACHBIT_*` 变量和 `achbit.*` 接口。macOS 签名可用 `ACHBIT_MACOS_SIGN_IDENTITY` 显式选择已有证书指纹。下载与发布状态以仓库 Releases 为准。
