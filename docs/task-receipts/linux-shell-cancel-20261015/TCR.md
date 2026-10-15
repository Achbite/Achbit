# Linux 工作区 Shell 取消终态修复 TCR

## 授权与问题

用户已明确同意最小 Kernel 取消判定调整和公共合同扩展，要求不改 macOS，完成真实 DeepSeek 的 Windows GUI → SSH → WSL 容器验收后推送开发分支。

现有实机证据：停止按钮已终止 Linux 容器内的 Shell、sleep 和 Bubblewrap，执行器保留输出并返回 tool_execution_cancelled；Kernel 在 Executing 阶段取消时统一将其覆盖为 indeterminate，最终 GUI 显示“运行状态待确认”。

## 实现范围

- 只对 Linux 内置前台工作区 Shell 的确定取消结果生成 cancelled ToolRecord；依据受控执行器正常返回的结构化结果，资源清理失败、未知结果及其他工具沿用原语义。macOS 与 Windows 原生 Kernel 的取消判定不变。
- 复用现有终止、等待回收、输出归档和取消回执，不新增重试、进程执行后端或恢复路径。
- 扩展 ToolExecutionRecord 的 cancelled 分支，允许可选 output，仍禁止 error。同步共享类型、Session 输出投影与模型上下文、GUI 结果校验；Run 取消结算和停止按钮不变。
- cancelled 表示执行已因取消而停止，不表示之前的副作用已回滚。保留停止前输出和归档引用，不修改历史记录，不变更 SQL 结构或数据库版本。
- 旧 GUI 的校验不接受 cancelled Shell 结果，本次更新实际验收的 Windows GUI 及 Linux Host/Session 配套资源，不增加版本或哈希门禁。

## 测试变更必要性与覆盖

原测试只证明执行器完成物理回收，未覆盖 Kernel 将确定取消结果转换成 ToolRecord 后，经 Session 和 GUI 消费的完整行为。本次合同扩展需要增加直接边界验证，不能仅修改展示文字或放宽已有失败断言。

1. Rust Kernel：Linux 内置前台工作区 Shell 取消后持久化 cancelled，保留 stdout 与归档引用；重复取消返回同一事实。资源清理失败、非工作区或非 Shell 工具、后台任务及非 Linux 分支不误判为确定取消。已有完成后取消竞态测试保持有效。
2. Session：cancelled ToolRecord 可保留 Shell 结果；Run 终态 cancelled；继续对话时模型可见取消事实与部分输出。原 indeterminate 和清理失败断言保留。
3. GUI/合同：接受 cancelled 且带有效 Shell 结果以及执行前取消不带结果；拒绝非法结果及 cancelled 携带 error。
4. 项目既有必验：开发容器内 test.sh required；失败先定位，不修改无关测试制造通过。
5. 实机：使用真实已配置 DeepSeek API，通过 Windows GUI 连接本机 WSL SSH 容器，完成一次只读命令，再启动前台长命令并点击现有停止按钮。核对真实进程退出、SSH 仍连接、ToolRecord/Run 为 cancelled、GUI 为“已取消”、部分输出和归档仍可读，完成标记不存在。

## 证据与交付边界

模型调用、构建、单测、实机加载和远端推送分别记录。WSL 验收不替代 TencentOS glibc 2.28 完整实机验证，不声明 macOS 运行验收。保留原失败记录。API Key、Host Token、SSH 私钥不进入测试文件、提交或日志。
