# 第二批简化：默认设置重复资产 TCR

用户已授权两批清理，测试用于链路及必要的 GUI 产品逻辑。config/defaults/user-settings.json 没有运行时消费者，仅在 Rust 测试中比较两个默认值；实际 Host 默认由 default_user_settings() 负责。

本项删除该重复 JSON 与 equality gate，不改变任何运行时默认、设置合并、校验或保存合同，不引入跨语言默认生成框架。

旧不变量：contextManagement 的两个默认值必须等于另一个手写文件。新不变量：实际默认关闭、阈值 500000；设置于下一运行生效；合法用户覆盖可接受，非法类型和范围仍被拒绝，删除设置仍恢复合法缺省。现有 automatic_context_defaults_and_next_run_validation 保留上述所有行为断言。

该测试不以重复资产存在作为通过条件；错误默认、错误生效时机及边界校验缺失仍然失败。适用检查与第二批基础 CLI 对话由主任务统一执行并记录。本项未增加测试矩阵，未改变产品功能。

## 本批实际结果

automatic_context_defaults_and_next_run_validation 既有测试通过；实际默认、下一运行生效与输入边界断言保留。tracked 代码和脚本已无删除 JSON 的消费者。

第二批 CLI/TUI/Host/工具进程单任务构建通过。使用本次容器开发产物，经真实 DeepSeek Flash 完成文件读取与同一 Session 追问两轮 CLI 对话；两轮均 completed、退出码 0，临时 Host/状态已释放。回执：`.build-cache/simplification-20261028/batch2-cli.json`。该结果仅证明基础 CLI 链路，不代表原生 GUI、标准包或跨平台验收。
