# Workbench Controls Example

在「设置 → 插件」添加此目录并启用，即可替换对话标题、设置导航和文件树的展示。它不默认安装；编辑 `index.mjs` 后，现有插件 watcher 会加载新模块，无需编译完整应用。

此示例只消费三个分区已有 owner 的视图数据和动作。它不读取文件 API、不发送 Session 命令、不保存额外的页面状态。

| slot | input.data.kind | 主要数据 | scope.actions |
| --- | --- | --- | --- |
| conversation.header | conversationHeader | sessionId、title、project、reader | toggleReader、toggleReaderExpanded、toggleTree |
| settings.navigation | settingsNavigation | pages、activePage、searchQuery | selectSettingsPage、setSettingsSearch |
| reader.tree | resourceTree | items、filter、showRuntime、selectedId、watchError、visible | setTreeFilter、setTreeRuntimeVisible、setTreeItemExpanded、openTreeItem、openTreeItemMenu |

`conversation.header` 的 `heading` 与 `reader` 是两个可挂载的现有区域；示例自绘标题，并调用 `scope.regions.mount('reader', container)` 保留已有 Reader tabs 和控制按钮。可以挂载 `heading` 保留原标题。

文件树的节点 ID 是 owner 提供的不透明 ID。展开和打开只接受当前展示的节点；不从 ID 推算路径。目录使用展开动作，文件使用打开动作，unavailable 节点保留错误并禁用操作。筛选仅匹配已加载节点，语义与内置文件树一致。

验证时可打开已有文件后替换插件，检查 Reader tabs 仍可切换；在设置中输入草稿后导航到另一页并返回，检查草稿仍在；展开目录、筛选并打开文件，再编辑示例样式，检查热更新后仍由同一文件树 owner 提供状态。真实鼠标、焦点、原生窗口布局需要在运行的 GUI 中确认。
