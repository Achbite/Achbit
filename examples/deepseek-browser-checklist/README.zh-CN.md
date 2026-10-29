# DeepSeek API：从网页资料到可操作的验收清单

[English](README.md) · [全部示例](../README.zh-CN.md)

使用 DeepSeek 与 Achbit 的 Computer Use 插件查阅公开文档，制作交互清单。本示例提供可直接打开的速查页面，以及用于生成自己版本的任务提示词。

![清单界面预览](report-checked.png)

## 打开示例

- 下载 [report.html](report.html)，用浏览器打开：中文单文件速查表，包含 5 组、18 项勾选清单、进度计数和本机状态保存。
- [sources.json](sources.json)：逐条列出事实、原始来源及查阅日期。
- [report-checked.png](report-checked.png)：清单界面预览。

勾选和备注保存在自己的浏览器中，可用重置按钮清除。勾选框只记录选择，不会执行浏览器兼容性测试。

## 制作自己的版本

按 [DeepSeek 接入指南](../../docs/product/deepseek.zh-CN.md) 配好 API，在 Achbit 中将输出目录打开为项目，在新的 GUI 对话中粘贴[任务提示词](prompt.zh-CN.txt)。保持内置 Computer Use 插件可用；任务需要访问公开网络并写入输出文件。

提示词要求生成中文速查页面、来源链接、交互进度和本地保存，并让 Agent 在内置浏览器打开页面、检查交互。

## 来源

文档引用及中文整理来源于 Microsoft 和 Playwright 贡献者的 [Browsers 文档](https://playwright.dev/docs/browsers)，原资料采用 [CC BY 4.0](https://github.com/microsoft/playwright.dev/blob/main/LICENSE)。示例提供中文改写、清单布局与本地交互；实际采用其中的浏览器支持信息时，请查阅最新来源文档。本示例不代表 Playwright 官方背书。
