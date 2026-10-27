# Achbit 界面样式入口

`palette.json` 是内置界面颜色的唯一色号表：`tokens` 保存 GUI 和 Editor 的语义色，`themes` 保存具名主题的浅色与深色配色，`terminal`、`diff` 保存终端和差异视图的颜色。组件引用语义变量；不要把新色号写回组件 CSS 或 TSX。

界面变量和保存的配色键统一使用 `--ac-*` 前缀；读取与保存按同一键名验证，未知键和非法颜色保留错误。

默认 Achbit 主题保持现有浅色风格，暗色通过背景、侧栏、内容面和浮层的明度区分层次。额外的 Catppuccin、Gruvbox、Nord 是适配 Achbit 界面角色的配色，不是这些项目的官方移植版本。参考：[Catppuccin palette](https://github.com/catppuccin/catppuccin#-palette)、[Gruvbox palette](https://github.com/morhetz/gruvbox/blob/master/colors/gruvbox.vim)、[Nord palette](https://www.nordtheme.com/docs/colors-and-palettes/)。

界面中的选择与编辑写入既有用户设置存储，不修改应用安装目录中的默认 JSON。`workbench.styleTokenOverrides` 是当前实际应用的配色；主题选中名称从实际配色推导。`gui.themeLibrary` 只保存导入的主题文档，添加主题不会改变已应用的颜色。浅色/深色独立选择，`gui.colorTheme` 仍只决定当前使用哪种模式；自定义强调色优先，选择强调色预设会清除两种模式的强调色覆盖。

## 导入格式

在“外观 → 主题配置 → 复制主题”复制当前完整的浅色与深色配色，保存成 JSON 或直接粘贴到“导入”窗口。文件结构为：

```json
{
  "name": "My Theme",
  "light": { "background": "#f4f4f6", "accent": "#0066cc" },
  "dark": { "background": "#1c1c1e", "accent": "#73b2ff" }
}
```

允许只提供一种模式；每种模式允许部分字段，缺省字段使用内置 Achbit 语义色。支持 `#RRGGBB` 和 `#RRGGBBAA`，不接受任意 CSS。未知字段、非法色号和空主题保留错误，不能提交。同名主题不会静默替换。

支持字段由 `userspace/gui/src/theme/palette.ts` 的 `PALETTE_FIELDS` 唯一登记：背景、侧栏、内容面、浮层、正文、次要文字、强调色、分隔线、次级内容面、悬停、按下、重点文字、辅助文字、控件边框、代码背景、成功、提示、错误。主题文件使用该登记表中的英文名称。

## 字体和图标

`userspace/gui/src/theme/typography.ts` 维护字体解析，所有选择通过同一用户设置存储保存。`gui.fontFamily` 默认温和阅读 · 无衬线（`warm-sans`，完整的 Achbit Quiet Reading Sans SC），已有显式选择保持不变。另有温和阅读 · 文楷（`warm`）、紧凑终端 · 文楷（`compact-kai`）、紧凑终端 · 无衬线（`compact`）、系统默认及已安装的自定义字体。每组的两版保持拉丁字形一致，只改变中文风格；紧凑两版均采用 ASCII 500、汉字 1000 单位的字宽。文楷是中文书写风格，无衬线版采用圆润黑体。主题只控制配色。

外观设置默认展示总字体和预览，字体详情中按界面、内容、终端与代码分组。`gui.interfaceFontFamily`、`gui.contentFontFamily`、`gui.terminalFontFamily` 默认 `inherit`；修改总字体同时将三项恢复为跟随，之后可分别覆盖。界面 `gui.fontSize` 与内容 `gui.contentFontSize` 默认 14 px（12–18），代码 `gui.codeFontSize` 默认 12 px（10–18）。字号独立于字体选择。GUI 的代码、命令输出、文件和 diff 消费终端字体，真实等宽度量或数字标签仍可使用专用等宽 token。

字体详情只保留字体与字号选择，不提供独立 TUI 配置、字体下载或终端配置导出。macOS 的 `Achbit-TUI.command` 与安装后的 `achbit-tui` 通过专用 Terminal 窗口加载字体，Windows 使用专用控制台：启动时读取同一设置中的 `gui.terminalFontFamily`，为 `inherit` 时跟随 `gui.fontFamily`，字号读取 `gui.codeFontSize`。TUI 中 `/font` 列出选项，`/font compact` 等命令仅覆盖当前窗口，`/font follow` 重新读取 GUI 选择；没有第二套字体偏好存储。普通终端及其默认配置不变。`--in-place`、非交互管道和 `--smoke` 保留原终端运行方式；Linux 的字形仍由外部终端控制。字库来源与复现信息在 `userspace/gui/src/assets/fonts/README.md`。

`userspace/gui/src/icons/registry.tsx` 是内置 UI 图标的注册入口，`UI_ICON_ROLES` 映射设置分类和活动栏的语义角色。使用 `UiIcon`，不在业务组件中定义 SVG 路径或用 Unicode 字符模拟图标。图标统一使用 24 × 24 网格、1.65 描边和 `currentColor`。品牌字标和资源内容图片不属于 UI 操作图标。

TUI 的四套内置字体使用同笔形的终端版本，统一为英文一格、中文两格；GUI 字库保留原来的比例字宽。字体切换保留专用窗口尺寸，现有 TUI 按更新的行列数重新排版。自定义终端字体须为固定字宽，不能将比例字体直接套入字符网格。

## 作用范围

默认色表覆盖自有 GUI/Editor 样式、终端色表和差异背景。用户导入及可视化配色编辑针对 GUI 语义色。代码语法高亮、外部 HTML/PDF/图片、插件自带内容由各自渲染器拥有；本入口不改写其内容颜色。

调整内置色号后使用项目 Docker 构建入口生成前端资源。用户保存主题或字体后立即应用于 GUI，无需重新构建；已打开的 macOS TUI 专用窗口使用 `/font follow` 重新读取字体与字号，或下次启动时应用。TUI 二进制、终端字库和原生窗口脚本的源码修改需要更新对应程序包并重启 TUI。
