#!/usr/bin/env python3
"""Build fixed-cell terminal faces from the bundled OFL reading fonts.

Run in the development container with fonttools 4.67.0. GUI WOFF2 files and
the original proportional reading faces are deliberately separate inputs.
"""
import argparse
from io import BytesIO
from pathlib import Path
import unicodedata
import zipfile

from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont


FAMILIES = ('Reading', 'ReadingSans', 'MonoKai', 'Mono')


def terminal_face(data, style):
    font = TTFont(BytesIO(data))
    assert font['head'].unitsPerEm == 1000
    cmap = font.getBestCmap()
    cells = {'.notdef': 500}
    for codepoint, name in cmap.items():
        char = chr(codepoint)
        width = (0 if font['hmtx'][name][0] == 0 or unicodedata.category(char) in ('Mn', 'Me', 'Cf', 'Cc')
                 else 1000 if unicodedata.east_asian_width(char) in 'WF' else 500)
        if name in cells and cells[name] != width:
            raise ValueError(f'Conflicting terminal widths for {name}: U+{codepoint:04X}')
        cells[name] = width
    glyph_set = font.getGlyphSet()
    for name, width in cells.items():
        advance, bearing = font['hmtx'][name]
        if advance == width:
            continue
        glyph = font['glyf'][name]
        if width and glyph.numberOfContours:
            glyph.recalcBounds(font['glyf'])
            ink = glyph.xMax - glyph.xMin
            # Keep narrow letterforms intact; fit wider Latin forms into one
            # cell. CJK shapes already occupy two cells and remain unchanged.
            scale = min(1, (width - 40) / max(ink, 1))
            offset = (width - ink * scale) / 2 - glyph.xMin * scale
            pen = TTGlyphPen(glyph_set)
            glyph_set[name].draw(TransformPen(pen, (scale, 0, 0, 1, offset, 0)))
            glyph = pen.glyph()
            font['glyf'][name] = glyph
            glyph.recalcBounds(font['glyf'])
            bearing = glyph.xMin
        font['hmtx'][name] = (width, bearing)
    font['post'].isFixedPitch = 1
    font['OS/2'].xAvgCharWidth = 500
    font['OS/2'].panose.bFamilyType = 2
    font['OS/2'].panose.bProportion = 9
    label = {'Reading': 'Reading', 'ReadingSans': 'Reading Sans', 'MonoKai': 'Mono Kai', 'Mono': 'Mono'}[style]
    # CONSOLE_FONT_INFOEX has only 32 UTF-16 units. Distinct short family names
    # let Windows select all four faces; macOS keeps the same PostScript names.
    family = f'DeepCode TUI {label} SC'
    postscript = f'DeepCodeQuietTerminal{style}SC-Regular'
    names = {1: family, 2: 'Regular', 3: postscript + ';0.101', 4: family + ' Regular',
             5: 'Version 0.101; fixed terminal cells', 6: postscript, 16: family, 17: 'Regular'}
    font['name'].names = [item for item in font['name'].names if item.nameID not in names]
    for name_id, value in names.items():
        font['name'].setName(value, name_id, 3, 1, 0x409)
    assert all(font['hmtx'][cmap[cp]][0] == 500 for cp in range(0x20, 0x7f))
    assert all(font['hmtx'][cmap[ord(ch)]][0] == 1000 for ch in '中文，。')
    output = BytesIO()
    font.save(output)
    return postscript + '.ttf', output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.source) as source, zipfile.ZipFile(args.output, 'w', zipfile.ZIP_DEFLATED) as output:
        for style in FAMILIES:
            name, data = terminal_face(source.read(f'DeepCodeQuiet{style}SC-Regular.ttf'), style)
            output.writestr(name, data)
            print(name, flush=True)
        for name in ('Maple-LICENSE.txt', 'Libertinus-OFL.txt', 'Libertinus-AUTHORS.txt', 'WenKai-OFL.txt', 'sources.json'):
            output.writestr(name, source.read(name))
        output.writestr('README.md', 'DeepCode Quiet Terminal SC\n\n'
            'Four OFL-derived fixed-cell faces for terminal rendering. ASCII: 500 units; CJK: 1000; UPM: 1000.\n'
            'Reading preserves Libertinus Sans letterforms fitted to the terminal grid; Mono uses Maple Mono.\n'
            'Kai uses LXGW WenKai CJK, Sans uses Resource Han Rounded from Maple Mono CN.\n'
            'GUI proportional fonts are unchanged. Keep all accompanying OFL notices.\n')


if __name__ == '__main__':
    main()
