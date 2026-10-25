# Achbit Quiet SC

| 内置选项 | 字体家族 | 中文风格 |
| --- | --- | --- |
| 温和阅读 · 文楷 | Achbit Quiet Reading SC | 文楷 |
| 温和阅读 · 无衬线 | Achbit Quiet Reading Sans SC | 圆润黑体 |
| 紧凑终端 · 文楷 | Achbit Quiet Mono Kai SC | 文楷 |
| 紧凑终端 · 无衬线 | Achbit Quiet Mono SC | 圆润黑体 |

温和阅读两版保留相同的比例字宽无衬线英文；紧凑终端两版保留相同的等宽英文，中英文按 1:2 字宽排列。
文楷是中文书写风格，不等同于西文衬线体。无衬线两版的中英文均采用无衬线字形。

GUI 直接加载随应用分发的 WOFF2；外观设置不再提供终端配置导出。
默认无衬线阅读字体保留完整字库，关闭 WOFF2 的 glyf/loca 变换以减少 WebView 首屏的字形重建开销；其他三套字体的编码保持不变。
macOS 和 Windows TUI 专用窗口使用 `Achbit-Quiet-Terminal-SC.zip` 中独立命名的 TTF 终端版本。四套风格均采用 ASCII 500、汉字 1000 单位的字宽；温和阅读保留原笔形，将宽英文适配到单格，GUI 的比例字宽 WOFF2 不变。macOS 字体通过 CoreText 在当前登录会话注册，使 Terminal 能加载它，不复制字体到系统字体目录，不修改全局默认字体。注册在退出登录后失效。
Windows 控制台使用可区分的短家族名称，启动时临时加载所需字体并在进程正常退出时释放；自定义字体须已安装且能被控制台识别。macOS 的 PostScript 名称保持不变。
切换字体时保留专用窗口尺寸，由终端更新行列数，再由 TUI 重新排版。自定义字体需要具有固定字宽；比例字体不能直接用于字符网格。

终端版本在容器内使用 fonttools 4.67.0 生成：`python scripts/build-tui-fonts.py --source userspace/gui/src/assets/fonts/Achbit-Quiet-SC.zip --output userspace/gui/src/assets/fonts/Achbit-Quiet-Terminal-SC.zip`。终端包同时保留四套原字库的许可和来源；不重新生成 GUI 字库。

All four fonts are renamed SIL OFL 1.1 derivatives. The accompanying notices must remain with redistributed fonts.
Reading Latin: Libertinus Sans 7.051. Mono Latin: Maple Mono NL CN 7.9.
Kai CJK: LXGW WenKai 1.522. Sans CJK and remaining glyphs: Maple Mono NL CN 7.9 (Resource Han Rounded).
These are not Claude or Optima fonts.
Regular only. No donor GSUB/GPOS or handcrafted small-size hinting.

The full WOFF2 fonts have the same cmap as their TTFs, not specimen subsets. sources.json records original downloads. To reproduce outlines, run build_fonts.py with fonttools 4.67.0 and brotli 1.2.0 inside the development container. Use --source-dir for the original fonts and --output-dir for generated TTFs and the receipt. The script also writes full WOFF2 fonts and the ZIP containing all four TTFs and these notices next to itself.
