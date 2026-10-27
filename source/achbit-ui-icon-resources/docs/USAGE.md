# Achbit 品牌与图标使用说明

## 品牌标识

产品名称保持 **Achbit**，主品牌使用完整纯字标。独立的 **DC** 简写图案将 A 与 C 左右并列，通过相接的曲线形成整体，保留清晰的字腔与开放轮廓。两者均使用原创几何路径，分别用于完整品牌展示和需要简写的场景。品牌母版不包含 `<text>`，也不嵌入或分发字体文件。

| 场景 | 资源 | 建议最小尺寸 |
| --- | --- | --- |
| 导航、标题、完整品牌展示 | `brand/svg/achbit-wordmark-*.svg` | 120 px 宽 |
| AC 独立简写图案 | `brand/svg/achbit-mark-*.svg` | 24 × 24 px |

- `light` 表示用于浅色背景，`dark` 表示用于深色背景。
- `mono` 使用 `currentColor`，适合内联到单色界面或印刷场景。
- 保持等比缩放。符号周围至少保留可见符号高度 1/4 的净空；字标周围至少保留大写字高 1/4 的净空。
- 完整字标和 DC 图案分别使用，主品牌区域保持纯字标。
- DC 图案使用透明背景与单一颜色，保持原有轮廓和开放空间。
- PNG 字标导出为 1016 × 224 px，DC 图案导出为 512 × 512 px，均提供明暗两套透明资源。

## 界面图标

图标共用 `0 0 24 24` 坐标系、圆端点和圆连接。视觉线宽随目标尺寸调整，避免小图标过轻、大图标过重。

| 导出尺寸 | 坐标系中的 stroke-width | 实际像素线宽约值 |
| ---: | ---: | ---: |
| 16 px | 2 | 1.33 px |
| 20 px | 1.85 | 1.54 px |
| 24 px | 1.75 | 1.75 px |
| 32 px | 1.65 | 2.20 px |
| 64 px | 1.5 | 4.00 px |

`ai-agent` 的 16 px 版本减少一个装饰星；`kernel` 的 16 px 版本使用实心内核，减少细碎边界。其余图标使用相同轮廓与对应光学线宽。应选择目标尺寸的导出文件，不将 64 px 版本当作 16 px 专用资源。

界面图标以轮廓为主。省略号、信息点、活动网格等需要实体面积的细节使用填充。状态必须同时保留不同形状与可读文字，不仅通过颜色区分。`refresh` 使用双箭头，`in-progress` 使用时钟与未闭合圆环；`chart-donut` 使用分段圆环，避免与普通状态圆形混淆。

图标尺寸不等于交互区域尺寸。按钮仍应由宿主界面提供适当留白、焦点提示与文本标签。

## 明暗主题

| 语义 | CSS token | 浅色背景 | 深色背景 |
| --- | --- | --- | --- |
| 中性 | `--dc-icon-neutral` | `#424854` | `#D9DEE7` |
| 弱提示 | `--dc-icon-muted` | `#737C89` | `#929BAA` |
| 蓝色 / 选中 | `--dc-icon-accent` | `#0868CE` | `#459CFF` |
| 成功 | `--dc-icon-success` | `#187D4B` | `#40D98B` |
| 警告 | `--dc-icon-warning` | `#996000` | `#FFBD59` |
| 错误 | `--dc-icon-error` | `#CE3541` | `#FF746C` |

`tokens/achbit-icon-tokens.css` 默认仍为深色主题。由宿主明确设置 `data-dc-theme="light"` 或 `data-dc-theme="dark"`；资源包不自行创建主题持久化或应用偏好。

### 内联 SVG

将目标 SVG 作为内联元素或组件使用，并在外层设置颜色。React / Vite 的 `?react` 导入方式仅适用于宿主已经配置 SVGR 的场景；本资源包不要求新增转换插件。

```html
<div data-dc-theme="light">
  <button type="button" aria-label="打开终端">
    <svg class="dc-icon" viewBox="0 0 24 24" aria-hidden="true">
      <use href="/icons/sprite/achbit-icons.svg#dc-icon-terminal"></use>
    </svg>
  </button>
</div>
```

Sprite 的已有 `dc-icon-*` ID 对应 24 px 轮廓，保留原有命名。`dc-icon-ai-agent-16` 与 `dc-icon-kernel-16` 提供精简轮廓。需要精确的 16 / 20 / 32 / 64 px 光学线宽时使用对应目录的独立 SVG。

### 作为图片使用

`<img>` 内部 SVG 不继承父页面的 `currentColor`。选择固定主题版本，禁止用父元素颜色或 CSS 滤镜推算资源色值。

```html
<!-- 浅色背景 -->
<img src="/icons/svg/themed-light/20/icon-folder-20.svg"
     width="20" height="20" alt="文件夹">
<!-- 深色背景；themed 为原有路径 -->
<img src="/icons/svg/themed/20/icon-folder-20.svg"
     width="20" height="20" alt="文件夹">
```

PNG 同样按背景选择：`png/` 用于深色背景，`png/light/` 用于浅色背景。两套图标均为透明背景。装饰性图像使用空 `alt`；图标按钮由按钮提供操作名称，避免重复朗读。

## 资源维护

1. 编辑 `sources/icons.json` 的图形与元数据，或 `brand/masters/` 中的品牌母版。
2. 预览布局修改 `sources/preview.html`；颜色与导出规格修改 `scripts/generate-assets.mjs`。
3. 在正确挂载当前 worktree 的项目开发容器内运行完整导出。
4. 检查浅色和深色图板、16 px 轮廓、所有资源引用及 PNG 尺寸。导出失败时先修复失败，不把已有 PNG 当作最新结果。

```sh
# 如开发容器尚未提供 PNG 渲染器，在容器内安装：
apt-get update
apt-get install -y --no-install-recommends librsvg2-bin

# 在容器内的 /workspace 下导出：
node source/achbit-ui-icon-resources/scripts/generate-assets.mjs
```

`preview/index.html` 为生成结果，包含实际 SVG，直接打开即可浏览，不依赖服务器、网络字体、框架或外部脚本。筛选与尺寸选择只改变预览，下载链接随尺寸更新。

## 设计参考

- [Apple HIG — Icons](https://developer.apple.com/design/human-interface-guidelines/icons)：图形与宿主界面的视觉重量保持协调。
- [Apple HIG — Typography](https://developer.apple.com/design/human-interface-guidelines/typography)：优先考虑可读性，以字重、比例和间距建立层级。

本资源包借鉴设计原则，未复制 Apple 品牌图形、SF Symbols 图形或字体资源。
