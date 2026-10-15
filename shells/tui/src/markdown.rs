//! Markdown presentation only. Session content is never rewritten.
use pulldown_cmark::{Alignment, CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
};

pub(crate) fn render(input: &str, width: u16, style: Style) -> Vec<Line<'static>> {
    let mut events = Parser::new_ext(
        input,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    );
    let mut writer = Writer::new(style);
    while let Some(event) = events.next() {
        if let Event::Start(Tag::Table(alignments)) = event {
            let rows = read_table(&mut events, style);
            let indent: usize = writer
                .prefixes
                .iter()
                .map(|p| Line::from(p.as_str()).width())
                .sum();
            writer.blank();
            for line in table_lines(rows, &alignments, usize::from(width).saturating_sub(indent)) {
                writer.begin_line();
                writer.current.spans.extend(line.spans);
                writer.newline();
            }
            writer.blank();
        } else {
            writer.event(event);
        }
    }
    writer.finish()
}

struct Writer {
    lines: Vec<Line<'static>>,
    current: Line<'static>,
    styles: Vec<Style>,
    prefixes: Vec<String>,
    lists: Vec<Option<u64>>,
    links: Vec<String>,
}

impl Writer {
    fn new(style: Style) -> Self {
        Self {
            lines: vec![],
            current: Line::default(),
            styles: vec![style],
            prefixes: vec![],
            lists: vec![],
            links: vec![],
        }
    }

    fn style(&self) -> Style {
        *self.styles.last().unwrap()
    }

    fn push_style(&mut self, style: Style) {
        self.styles.push(self.style().patch(style));
    }

    fn begin_line(&mut self) {
        if self.current.spans.is_empty() && !self.prefixes.is_empty() {
            self.current
                .spans
                .push(Span::styled(self.prefixes.concat(), self.style()));
        }
    }

    fn text(&mut self, text: &str) {
        // Split before constructing a Line: Line::from removes newlines.
        for (index, part) in text.split('\n').enumerate() {
            if index > 0 {
                self.newline();
            }
            if !part.is_empty() {
                self.begin_line();
                self.current
                    .spans
                    .push(Span::styled(part.replace('\t', "    "), self.style()));
            }
        }
    }

    fn newline(&mut self) {
        self.lines.push(std::mem::take(&mut self.current));
    }

    fn flush(&mut self) {
        if !self.current.spans.is_empty() {
            self.newline();
        }
    }

    fn blank(&mut self) {
        self.flush();
        if self.lines.last().is_some_and(|line| line.width() > 0) {
            self.lines.push(Line::default());
        }
    }

    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { .. } => {
                    self.blank();
                    self.push_style(Style::default().add_modifier(Modifier::BOLD));
                }
                Tag::Strong => self.push_style(Style::default().add_modifier(Modifier::BOLD)),
                Tag::Emphasis => self.push_style(Style::default().add_modifier(Modifier::ITALIC)),
                Tag::Strikethrough => {
                    self.push_style(Style::default().add_modifier(Modifier::CROSSED_OUT))
                }
                Tag::BlockQuote(_) => {
                    self.flush();
                    self.prefixes.push("│ ".into());
                }
                Tag::CodeBlock(kind) => {
                    self.blank();
                    if let CodeBlockKind::Fenced(language) = kind {
                        if !language.is_empty() {
                            self.push_style(Style::default().fg(Color::DarkGray));
                            self.text(&format!("  {language}"));
                            self.styles.pop();
                            self.newline();
                        }
                    }
                    self.prefixes.push("  ".into());
                    self.push_style(Style::default());
                }
                Tag::List(start) => {
                    self.flush();
                    self.lists.push(start);
                }
                Tag::Item => {
                    self.flush();
                    let marker = match self.lists.last_mut() {
                        Some(Some(number)) => {
                            let marker = format!("{number}. ");
                            *number += 1;
                            marker
                        }
                        _ => "• ".into(),
                    };
                    self.text(&marker);
                    self.prefixes.push(" ".repeat(Line::from(marker).width()));
                }
                Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. } => {
                    self.links.push(dest_url.to_string());
                    self.push_style(
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::UNDERLINED),
                    );
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Heading(_) => {
                    self.styles.pop();
                    self.blank();
                }
                TagEnd::Strong | TagEnd::Emphasis | TagEnd::Strikethrough => {
                    self.styles.pop();
                }
                TagEnd::Paragraph => {
                    if self.lists.is_empty() {
                        self.blank();
                    } else {
                        self.flush();
                    }
                }
                TagEnd::BlockQuote(_) => {
                    self.flush();
                    self.prefixes.pop();
                    self.blank();
                }
                TagEnd::CodeBlock => {
                    self.flush();
                    self.prefixes.pop();
                    self.styles.pop();
                    self.blank();
                }
                TagEnd::Item => {
                    self.flush();
                    self.prefixes.pop();
                }
                TagEnd::List(_) => {
                    self.lists.pop();
                    if self.lists.is_empty() {
                        self.blank();
                    }
                }
                TagEnd::Link | TagEnd::Image => {
                    if let Some(url) = self.links.pop() {
                        if !self.current.to_string().ends_with(&url) {
                            self.text(&format!(" ({url})"));
                        }
                    }
                    self.styles.pop();
                }
                _ => {}
            },
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => self.text(&text),
            Event::Code(text) => {
                self.push_style(Style::default().add_modifier(Modifier::BOLD));
                self.text(&text);
                self.styles.pop();
            }
            Event::SoftBreak | Event::HardBreak => self.newline(),
            Event::Rule => {
                self.blank();
                self.push_style(Style::default().fg(Color::DarkGray));
                self.text("────────");
                self.styles.pop();
                self.blank();
            }
            Event::TaskListMarker(checked) => self.text(if checked { "[x] " } else { "[ ] " }),
            Event::FootnoteReference(text) => self.text(&format!("[{text}]")),
            Event::InlineMath(text) => self.text(&format!("${text}$")),
            Event::DisplayMath(text) => {
                self.blank();
                self.text(&format!("$${text}$$"));
                self.blank();
            }
        }
    }

    fn finish(mut self) -> Vec<Line<'static>> {
        self.flush();
        while self.lines.last().is_some_and(|line| line.spans.is_empty()) {
            self.lines.pop();
        }
        self.lines
    }
}

type Row = Vec<Vec<Line<'static>>>;

fn read_table<'a>(events: &mut impl Iterator<Item = Event<'a>>, style: Style) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut cell = Writer::new(style);
    for event in events {
        match event {
            Event::End(TagEnd::Table) => break,
            Event::Start(Tag::TableCell) => cell = Writer::new(style),
            Event::End(TagEnd::TableCell) => {
                row.push(std::mem::replace(&mut cell, Writer::new(style)).finish())
            }
            Event::End(TagEnd::TableHead | TagEnd::TableRow) => rows.push(std::mem::take(&mut row)),
            Event::Start(Tag::TableHead | Tag::TableRow) => {}
            other => cell.event(other),
        }
    }
    rows
}

fn wrap_cell(lines: Vec<Line<'static>>, width: usize) -> Vec<Line<'static>> {
    let mut wrapped = Vec::new();
    for line in lines {
        let mut row = Line::default();
        let mut used = 0;
        for grapheme in line.styled_graphemes(Style::default()) {
            let cells = Span::raw(grapheme.symbol).width();
            if used + cells > width && used > 0 {
                wrapped.push(std::mem::take(&mut row));
                used = 0;
            }
            row.spans
                .push(Span::styled(grapheme.symbol.to_string(), grapheme.style));
            used += cells;
        }
        wrapped.push(row);
    }
    wrapped
}

fn table_lines(rows: Vec<Row>, alignments: &[Alignment], width: usize) -> Vec<Line<'static>> {
    let columns = alignments.len();
    if columns == 0 {
        return vec![];
    }
    // Very narrow terminals read each row vertically instead of cutting off columns.
    if width < columns * 5 + 1 {
        let headers: Vec<_> = rows
            .first()
            .into_iter()
            .flatten()
            .map(|cell| Text::from(cell.clone()).to_string())
            .collect();
        let mut lines = Vec::new();
        if rows.len() == 1 {
            return headers.into_iter().map(Line::from).collect();
        }
        for row in rows.into_iter().skip(1) {
            for (index, cell) in row.into_iter().enumerate() {
                lines.push(Line::from(Span::styled(
                    format!("{}:", headers[index]),
                    Style::default().add_modifier(Modifier::BOLD),
                )));
                lines.extend(cell);
            }
            lines.push(Line::default());
        }
        return lines;
    }
    let mut widths = vec![2; columns];
    for row in &rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(cell.iter().map(Line::width).max().unwrap_or(0));
        }
    }
    let available = width - columns * 3 - 1;
    while widths.iter().sum::<usize>() > available {
        let index = (0..columns).max_by_key(|&index| widths[index]).unwrap();
        widths[index] -= 1;
    }
    let border = Style::default().fg(Color::DarkGray);
    let mut output = Vec::new();
    for (row_index, row) in rows.into_iter().enumerate() {
        let cells: Vec<_> = row
            .into_iter()
            .zip(&widths)
            .map(|(cell, &width)| wrap_cell(cell, width))
            .collect();
        let height = cells.iter().map(Vec::len).max().unwrap_or(1).max(1);
        for line_index in 0..height {
            let mut spans = vec![Span::styled("│ ", border)];
            for (index, cell) in cells.iter().enumerate() {
                let line = cell.get(line_index).cloned().unwrap_or_default();
                let padding = widths[index].saturating_sub(line.width());
                let left = match alignments[index] {
                    Alignment::Right => padding,
                    Alignment::Center => padding / 2,
                    _ => 0,
                };
                spans.push(Span::raw(" ".repeat(left)));
                spans.extend(line.spans.into_iter().map(|span| {
                    if row_index == 0 {
                        span.patch_style(Style::default().add_modifier(Modifier::BOLD))
                    } else {
                        span
                    }
                }));
                spans.push(Span::raw(" ".repeat(padding - left)));
                spans.push(Span::styled(
                    if index + 1 == columns {
                        " │"
                    } else {
                        " │ "
                    },
                    border,
                ));
            }
            output.push(Line::from(spans));
        }
        if row_index == 0 {
            output.push(Line::from(Span::styled(
                format!(
                    "├{}┤",
                    widths
                        .iter()
                        .map(|width| "─".repeat(width + 2))
                        .collect::<Vec<_>>()
                        .join("┼")
                ),
                border,
            )));
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_keeps_block_structure_and_inline_content() {
        let lines = render("## 能力\n\n第一段\n第二行\n\n- **检查**项目\n- 查看 `src/main.rs`\n\n[来源](https://example.com)\n\n```rust\nfn main() {\n    println!(\"ok\");\n}\n```", 80, Style::default());
        let text = Text::from(lines.clone()).to_string();
        assert!(
            text.contains("能力\n\n第一段\n第二行\n\n• 检查项目\n• 查看 src/main.rs"),
            "{text}"
        );
        assert!(text.contains("来源 (https://example.com)"));
        assert!(
            text.contains("  fn main() {\n      println!(\"ok\");\n  }"),
            "{text}"
        );
        assert!(!text.contains("**"));
        assert!(!text.contains("```"));
        assert!(
            lines
                .iter()
                .flat_map(|line| &line.spans)
                .any(|span| span.content == "检查"
                    && span.style.add_modifier.contains(Modifier::BOLD))
        );
    }

    #[test]
    fn table_wraps_chinese_and_preserves_all_cells_in_a_narrow_view() {
        let markdown =
            "| 名称 | 描述 |\n| --- | --- |\n| DeepCode | 中文开发环境 é |\n| Pi | 终端 |";
        for width in [24, 60] {
            let lines = render(markdown, width, Style::default());
            assert!(
                lines.iter().all(|line| line.width() <= usize::from(width)),
                "{lines:?}"
            );
            let visible: String = Text::from(lines)
                .to_string()
                .chars()
                .filter(|c| !c.is_whitespace() && !"│├┼┤─".contains(*c))
                .collect();
            assert!(visible.contains("DeepCode"), "{visible}");
            assert!(visible.contains("中文开发环境é"), "{visible}");
            assert!(visible.contains("Pi终端"), "{visible}");
        }
        let narrow = Text::from(render(markdown, 8, Style::default())).to_string();
        assert!(narrow.contains("名称:\nDeepCode"));
        assert!(narrow.contains("描述:\n中文开发环境 é"));
        let header_only = Text::from(render(
            "| 名称 | 描述 |\n| --- | --- |",
            8,
            Style::default(),
        ))
        .to_string();
        assert!(header_only.contains("名称\n描述"));
    }

    #[test]
    fn incomplete_stream_keeps_code_and_nested_list_lines() {
        let text = Text::from(render(
            "1. 第一项\n   - 子项\n2. 第二项\n\n```text\n还在生成\nnext",
            40,
            Style::default(),
        ))
        .to_string();
        assert!(text.contains("1. 第一项\n   • 子项\n2. 第二项"), "{text}");
        assert!(text.contains("  还在生成\n  next"), "{text}");
    }
}
