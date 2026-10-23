# DeepSeek API：从网页资料到可操作的验收清单

[English](README.md) · [全部示例](../README.zh-CN.md)

这是 2026-10-23 在 Achbit macOS 隔离 Debug GUI 中完成的真实任务，模型为 **DeepSeek API 的 `deepseek-flash`**。Agent 查阅公开网页，生成可用文件，再回到浏览器检查实际交互。

![真实点击后生成的验收清单](report-checked.png)

## 查看产出

- 下载 [report.html](report.html)，用浏览器打开：中文单文件速查表，包含 5 组、18 项勾选清单、进度计数和本机状态保存。
- [sources.json](sources.json)：逐条列出事实、原始来源及查阅日期。
- [report-checked.png](report-checked.png)：真实运行截图，未进行视觉修图。
- [run-summary.json](run-summary.json)：实际模型、完成状态、用量和工具结果摘要。

HTML、来源台账和截图均直接复制自 Agent 产出，没有手工改写成品。下载到自己的浏览器后，勾选状态保存在自己的浏览器中。

## 实际执行过程

1. 在 Achbit GUI 中，DeepSeek 使用 Computer Use 插件打开 [Playwright 官方浏览器文档](https://playwright.dev/docs/browsers)，读取页面并查看 Firefox、WebKit 章节。
2. 生成 `report.html`、`sources.json`，用本地命令检查文件结构。
3. 用 Achbit 内置浏览器打开成品，点击第一个清单项，检查画面并刷新。总计数从 **0/18 变为 1/18**，分组计数为 **1/3**，进度显示 **6%**；刷新后勾选仍然保留。
4. 三个文件作为产物回到同一会话。Session 记录的终态为 `completed`，本次用时约 **5 分 16 秒**；这只是一次实际记录，不是速度承诺。

这个示例展示 Achbit 如何把“浏览网页、编写文件、实际操作页面、检查画面、交付产物”接在同一任务中。每一步都经过真实模型与实际工具调用。

## 自己试一次

按 [DeepSeek 接入指南](../../docs/product/deepseek.zh-CN.md) 配好 API，在 GUI 新建对话，粘贴[原始任务](prompt.zh-CN.txt)，保持内置 Computer Use 插件可用。任务需要访问公开网络并写入本地产出；本次没有安装额外依赖或启动服务。

## 证据边界

截图中的勾选用于验证清单交互，**不代表对应的真实验收项目已执行**。本次没有安装或运行 Chromium、Firefox、WebKit 兼容性测试。仅检查 1280 × 800 视口，未验收窄屏或外部原生应用控制。

运行中保留了三次浏览器操作失败：首次页面尚未加载完成、本地文件 URL 不被网页导航入口接受、直接点击的 input 被自绘控件遮挡。模型依据实际返回状态继续使用支持的操作；最终完成不代表每次调用均成功。

文档引用及中文整理来源于 Microsoft 和 Playwright 贡献者的 [Browsers 文档](https://playwright.dev/docs/browsers)，原资料采用 [CC BY 4.0](https://github.com/microsoft/playwright.dev/blob/main/LICENSE)。中文改写、清单布局和交互由本次任务生成；本示例不代表 Playwright 官方背书。
