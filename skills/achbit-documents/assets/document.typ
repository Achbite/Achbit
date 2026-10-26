#set document(title: "文档标题")
#set page(paper: "a4", margin: 20mm, numbering: "1")
#set text(size: 11pt, lang: "zh", fill: rgb("#252923"))
#set par(leading: 0.65em)
#show heading: set text(fill: rgb("#1b365d"))

= 文档标题

与读者和用途相关的简短说明。按实际任务替换正文、表格和图示。

== 章节标题

正文可以包含中文、English、*强调*和 $a^2 + b^2 = c^2$。

#table(
  columns: (1fr, auto, auto),
  align: (left, right, right),
  inset: 7pt,
  stroke: 0.5pt + rgb("#deddd3"),
  fill: (x, y) => if y == 0 { rgb("#f5f4ed") } else { none },
  table.header([项目], [数量], [金额]),
  [示例条目 A], [2], [12.50],
  [示例条目 B], [3], [18.00],
  [合计], [5], [30.50],
)

// A short document can omit this page break and the example figure.
#pagebreak()

== 图示

#let diagram = "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='40' viewBox='0 0 96 40'><rect x='0' y='0' width='48' height='40' fill='#008000'/><rect x='48' y='0' width='48' height='40' fill='#ffa500'/></svg>"
#figure(
  image(bytes(diagram), format: "svg", width: 30mm),
  caption: [嵌入式矢量图：左侧绿色，右侧橙色。],
)

根据实际内容增删章节，不保留示例文字。
