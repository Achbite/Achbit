//! Character-cell math presentation. Parsing errors retain their original source in Markdown.
use pulldown_latex::{Parser, RenderConfig, Storage};
use ratatui::{style::Style, text::Line};

pub(crate) fn render(source: &str, width: usize) -> Result<Vec<String>, String> {
    let storage = Storage::new();
    // Validate before rendering: an unknown command must not become a successful equation.
    let events = Parser::new(source, &storage)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut mathml = String::new();
    pulldown_latex::push_mathml(
        &mut mathml,
        events.into_iter().map(Ok::<_, std::convert::Infallible>),
        RenderConfig::default(),
    )
    .map_err(|error| error.to_string())?;
    let rendered = tui_math::MathRenderer::new()
        .render_mathml(&mathml)
        .map_err(|error| error.to_string())?;
    fit(&rendered, width.max(1))
}

// Wrap the whole two-dimensional grid at empty columns. Wrapping each text row
// independently would detach denominators and limits from their numerators/operators.
fn fit(rendered: &str, width: usize) -> Result<Vec<String>, String> {
    let mut grid: Vec<Vec<String>> = rendered
        .lines()
        .map(|text| {
            let line = Line::from(text);
            let mut cells = Vec::new();
            for grapheme in line.styled_graphemes(Style::default()) {
                let size = Line::from(grapheme.symbol).width();
                if size == 0 {
                    if let Some(last) = cells.last_mut() {
                        *last += grapheme.symbol;
                    }
                } else {
                    cells.push(grapheme.symbol.to_string());
                    cells.extend(std::iter::repeat_n(String::new(), size - 1));
                }
            }
            cells
        })
        .collect();
    let mut remaining = grid.iter().map(Vec::len).max().unwrap_or(0);
    for row in &mut grid {
        row.resize(remaining, " ".into());
    }
    let mut result = Vec::new();
    while remaining > 0 {
        let count = if remaining <= width {
            remaining
        } else {
            (1..=width)
                .rev()
                .find(|&col| grid.iter().all(|row| row[col] == " "))
                .ok_or_else(|| format!("formula needs a wider view (available: {width} columns)"))?
        };
        if !result.is_empty() {
            result.push(String::new());
        }
        result.extend(
            grid.iter()
                .map(|row| row[..count].concat().trim_end().to_string()),
        );
        for row in &mut grid {
            row.drain(..count);
        }
        remaining -= count;
        while remaining > 0 && grid.iter().all(|row| row[0] == " ") {
            for row in &mut grid {
                row.remove(0);
            }
            remaining -= 1;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn narrow_formulas_wrap_as_aligned_blocks() {
        let lines = render(r"\frac{AB}{xy} + \frac{CD}{zw} = \frac{EF}{uv}", 12).unwrap();
        assert!(lines
            .iter()
            .all(|line| Line::from(line.as_str()).width() <= 12));
        for (numerator, denominator) in [("AB", "xy"), ("CD", "zw"), ("EF", "uv")] {
            let row = lines
                .iter()
                .position(|line| line.contains(numerator))
                .unwrap();
            assert!(lines[row + 1].contains("──"));
            assert_eq!(lines[row].find(numerator), lines[row + 2].find(denominator));
        }
        assert!(render(r"\frac{abcdefghijklmnop}{qrstuvwxyzabcdef}", 8).is_err(),
            "an indivisible fraction must not turn into unrelated wrapped numerator/denominator rows");
    }
}
