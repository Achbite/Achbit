// Word wrapping follows Ratatui 0.29’s untrimmed WordWrapper, adapted for indexed rows.
// The MIT License (MIT)
//
// Copyright (c) 2016-2022 Florian Dehau
// Copyright (c) 2023-2024 The Ratatui Developers
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

use ratatui::{
    layout::Rect,
    prelude::Frame,
    text::{Line, Span, StyledGrapheme, Text},
    widgets::Paragraph,
};
use std::collections::VecDeque;

/// Document offsets are visual rows. Only the visible rows have terminal coordinates.
#[derive(Clone)]
pub(super) struct Document<'a>(Vec<Line<'a>>);

impl<'a> Document<'a> {
    pub(super) fn new(text: Text<'a>, width: u16) -> Self {
        let mut rows = Vec::with_capacity(text.lines.len());
        if width != 0 {
            for mut line in text.lines {
                line.style = text.style.patch(line.style);
                line.alignment = line.alignment.or(text.alignment);
                if line.width() <= usize::from(width)
                    && line
                        .spans
                        .iter()
                        .any(|span| !span.content.trim().is_empty())
                {
                    rows.push(line);
                } else {
                    wrap_line(&line, usize::from(width), &mut rows);
                }
            }
        }
        Self(rows)
    }

    pub(super) fn maximum(&self, height: u16) -> usize {
        self.0.len().saturating_sub(usize::from(height))
    }

    pub(super) fn draw(&self, frame: &mut Frame<'_>, body: Rect, offset: usize) {
        for (y, line) in (body.top()..body.bottom()).zip(self.0.iter().skip(offset)) {
            frame.render_widget(
                Paragraph::new(line.clone()),
                Rect::new(body.x, y, body.width, 1),
            );
        }
    }
}

// Keep styled graphemes in their word until we know whether the word fits.
// Whitespace consumed at a wrap does not indent the following word.
fn wrap_line<'a>(source: &Line<'_>, width: usize, rows: &mut Vec<Line<'a>>) {
    let mut row = Vec::new();
    let mut spaces = VecDeque::new();
    let mut word = Vec::new();
    let (mut used, mut spacing, mut letters) = (0, 0, 0);
    let first = rows.len();
    let mut emit = |cells: &mut Vec<StyledGrapheme<'_>>| {
        let mut line = Line::default().style(source.style);
        line.alignment = source.alignment;
        for cell in cells.drain(..) {
            if let Some(span) = line
                .spans
                .last_mut()
                .filter(|span| span.style == cell.style)
            {
                span.content.to_mut().push_str(cell.symbol);
            } else {
                line.spans
                    .push(Span::styled(cell.symbol.to_owned(), cell.style));
            }
        }
        rows.push(line);
    };
    for cell in source.styled_graphemes(source.style) {
        let cells = Span::raw(cell.symbol).width();
        if cells > width {
            continue;
        }
        let space = cell.symbol == "\u{200b}"
            || (cell.symbol != "\u{a0}" && cell.symbol.chars().all(char::is_whitespace));
        if (space && !word.is_empty()) || (row.is_empty() && spacing + letters + cells > width) {
            row.extend(spaces.drain(..).map(|(cell, _)| cell));
            row.append(&mut word);
            used += spacing + letters;
            spacing = 0;
            letters = 0;
        }
        if used >= width || used + spacing + letters + cells > width {
            emit(&mut row);
            let mut available = width.saturating_sub(used);
            used = 0;
            while spaces.front().is_some_and(|&(_, size)| size <= available) {
                let (_, size) = spaces.pop_front().unwrap();
                spacing -= size;
                available -= size;
            }
            if space && spaces.is_empty() {
                continue;
            }
        }
        if space {
            spacing += cells;
            spaces.push_back((cell, cells));
        } else {
            letters += cells;
            word.push(cell);
        }
    }
    if row.is_empty() && word.is_empty() && !spaces.is_empty() {
        emit(&mut row);
    }
    row.extend(spaces.into_iter().map(|(cell, _)| cell));
    row.append(&mut word);
    if !row.is_empty() {
        emit(&mut row);
    } else if rows.len() == first {
        rows.push(Line::default());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{
        backend::TestBackend,
        style::{Color, Modifier},
        widgets::{Paragraph, Wrap},
        Terminal,
    };

    #[test]
    fn visual_rows_match_styled_word_wrapping_after_scrolling() {
        let text = Text::from(vec![
            Line::from(vec![
                Span::styled("wide 中文", Color::Blue),
                Span::styled(" words end", Modifier::BOLD),
            ]),
            Line::from("  indent   mixed\u{a0}words\u{200b}x"),
            Line::from("longwordwithoutspaces"),
            Line::from(""),
            Line::from("   "),
            Line::from("last"),
        ]);
        for width in [2, 7, 13] {
            let paragraph = Paragraph::new(text.clone()).wrap(Wrap { trim: false });
            let doc = Document::new(text.clone(), width);
            let mut reference = Terminal::new(TestBackend::new(width, 3)).unwrap();
            let mut actual = Terminal::new(TestBackend::new(width, 3)).unwrap();
            for y in 0..paragraph.line_count(width) {
                reference
                    .draw(|f| f.render_widget(paragraph.clone().scroll((y as u16, 0)), f.area()))
                    .unwrap();
                actual.draw(|f| doc.draw(f, f.area(), y)).unwrap();
                assert_eq!(
                    actual.backend().buffer(),
                    reference.backend().buffer(),
                    "width={width} row={y}"
                );
            }
        }
    }

    #[test]
    fn wrapped_styled_graphemes_are_visible_when_a_wide_glyph_crosses_the_edge() {
        let prefix = format!("a{}", "中".repeat(39));
        for width in [3, 7, 40, 79, 80] {
            let line = Line::from(vec![
                Span::styled(prefix.as_str(), Color::Blue),
                Span::styled("末", Color::Red),
            ]);
            let doc = Document::new(Text::from(line), width);
            let mut terminal = Terminal::new(TestBackend::new(width, 1)).unwrap();
            let mut visible = String::new();
            for offset in 0..=doc.maximum(1) {
                terminal.draw(|f| doc.draw(f, f.area(), offset)).unwrap();
                let screen = terminal.backend().buffer();
                let mut column = 0;
                while column < width {
                    let cell = &screen[(column, 0)];
                    // A wide leading cell also occupies the following terminal column.
                    column += Span::raw(cell.symbol()).width().max(1) as u16;
                    if cell.symbol() != " " {
                        visible.push_str(cell.symbol());
                        let color = if cell.symbol() == "末" {
                            Color::Red
                        } else {
                            Color::Blue
                        };
                        assert_eq!(cell.fg, color);
                    }
                }
            }
            assert_eq!(visible, format!("{prefix}末"), "terminal width {width}");
        }
    }

    #[test]
    fn single_wrapped_line_can_reach_its_final_word_after_65535_rows() {
        let doc = Document::new(Text::raw(format!("{}end", "abcd".repeat(66000))), 4);
        let mut terminal = Terminal::new(TestBackend::new(4, 2)).unwrap();
        terminal
            .draw(|f| doc.draw(f, f.area(), doc.maximum(2)))
            .unwrap();
        let screen = terminal.backend().buffer();
        assert_eq!(screen[(0, 0)].symbol(), "a");
        assert_eq!(screen[(0, 1)].symbol(), "e");
        assert_eq!(screen[(2, 1)].symbol(), "d");
    }
}
