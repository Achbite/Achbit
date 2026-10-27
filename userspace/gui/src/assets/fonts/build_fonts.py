"""Build the OFL-derived Achbit fonts from the sources in sources.json."""
from pathlib import Path
from functools import lru_cache
import argparse
import json
import subprocess
import sys
import unicodedata
import zipfile
from fontTools.ttLib import TTFont
from fontTools.ttLib.woff2 import WOFF2FlavorData
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

ROOT = Path(__file__).resolve().parent
VARIANTS = {
    'warm': ('reading', 'Achbit Quiet Reading SC', 'kai'),
    'warm-sans': ('reading', 'Achbit Quiet Reading Sans SC', 'sans'),
    'compact-kai': ('mono', 'Achbit Quiet Mono Kai SC', 'kai'),
    'compact': ('mono', 'Achbit Quiet Mono SC', 'sans'),
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-dir', type=Path, default=ROOT)
parser.add_argument('--output-dir', type=Path, default=ROOT,
                    help='TTF and build receipts; web fonts and the download ZIP go next to this script.')
parser.add_argument('--variant', choices=VARIANTS, help='Build just one family; omission builds and packages all four.')
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
if args.variant is None:
    # Large CJK outlines and WOFF2 compression must release memory between families.
    receipts = []
    for variant in VARIANTS:
        subprocess.run([sys.executable, __file__, '--source-dir', str(args.source_dir),
                        '--output-dir', str(args.output_dir), '--variant', variant], check=True)
        receipts.append(json.loads((args.output_dir / f'{variant}.json').read_text()))
    (args.output_dir / 'font-build-receipt.json').write_text(json.dumps(receipts, ensure_ascii=False, indent=2) + '\n')
    with zipfile.ZipFile(ROOT / 'Achbit-Quiet-SC.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for receipt in receipts:
            archive.write(args.output_dir / receipt['file'], receipt['file'])
        for name in ('README.md', 'sources.json', 'Maple-LICENSE.txt', 'Libertinus-OFL.txt',
                     'Libertinus-AUTHORS.txt', 'WenKai-OFL.txt'):
            archive.write(ROOT / name, name)
    sys.exit(0)
UPM = 1000
SOURCES = {
    "maple": TTFont(args.source_dir / "MapleMonoNL-CN-Regular.ttf"),
    "libertinus": TTFont(args.source_dir / "LibertinusSans-Regular.ttf"),
    "wenkai": TTFont(args.source_dir / "LXGWWenKai-Regular.ttf"),
}
CMAPS = {key: font.getBestCmap() for key, font in SOURCES.items()}
GLYPHSETS = {key: font.getGlyphSet() for key, font in SOURCES.items()}
LICENSES = [ROOT / name for name in ("Maple-LICENSE.txt", "Libertinus-OFL.txt", "WenKai-OFL.txt")]
OFL = "\n\n".join(path.read_text() for path in LICENSES)
COPYRIGHT = "\n".join(path.read_text().split("This Font Software")[0].strip() for path in LICENSES)
COPYRIGHT += "\nAchbit Quiet SC review derivative, 2026."



def is_cjk(cp):
    return (0x2E80 <= cp <= 0xA4CF or 0xAC00 <= cp <= 0xD7AF
            or 0xF900 <= cp <= 0xFAFF or 0xFE30 <= cp <= 0xFFEF
            or 0x20000 <= cp <= 0x323AF)


def is_latin_reading(cp):
    return (0x20 <= cp <= 0x024F or 0x1E00 <= cp <= 0x1EFF
            or 0x2000 <= cp <= 0x206F or 0x20A0 <= cp <= 0x20CF)


@lru_cache(maxsize=None)
def outline(source, glyph_name):
    pen = DecomposingRecordingPen(GLYPHSETS[source])
    GLYPHSETS[source][glyph_name].draw(pen)
    return pen


def draw(source, glyph_name, matrix):
    pen = TTGlyphPen(None)
    outline(source, glyph_name).replay(TransformPen(pen, matrix))
    glyph = pen.glyph()
    return glyph


def build(kind, family, cjk_style):
    glyphs = {}
    metrics = {}
    cmap = {}
    keys = {}
    coverage = dict(CMAPS["maple"])
    if kind == "reading":
        coverage.update({cp: name for cp, name in CMAPS["libertinus"].items()
                         if is_latin_reading(cp)})
    glyphs[".notdef"] = draw("maple", ".notdef", (1, 0, 0, 1, 0, 0))
    metrics[".notdef"] = (500, 0)
    for cp in sorted(coverage):
        source = "maple"
        if kind == "reading" and is_latin_reading(cp) and cp in CMAPS["libertinus"]:
            source = "libertinus"
        elif cjk_style == "kai" and is_cjk(cp) and cp in CMAPS["wenkai"]:
            source = "wenkai"
        old = CMAPS[source][cp]
        original_width = SOURCES[source]["hmtx"][old][0]
        if source == "libertinus":
            # Retain proportional humanist forms; align capitals to the code face.
            sx, sy = 1.05, 1.08
            advance = round(original_width * sx)
            tx = ty = 0
        elif source == "wenkai" and original_width > 0:
            # Pen-shaped CJK forms make the reading design visibly distinct.
            advance = original_width if kind == "reading" else (1000 if unicodedata.east_asian_width(chr(cp)) in "WF" else 500)
            sx = sy = 0.98
            if kind == "mono":
                sx = min(sx, advance / original_width)
            tx = (advance - original_width * sx) / 2
            ty = (1 - sy) * 370
        elif is_cjk(cp) and original_width > 0:
            # Remove the donor's generous cell side space, preserving Han shapes.
            advance = 1000 if unicodedata.east_asian_width(chr(cp)) in "WF" else 500
            sx = sy = 0.98 if kind == "mono" or cjk_style == "sans" else 1.02
            if advance == 500:
                sx = min(sx, advance / original_width)
            tx = (advance - original_width * sx) / 2
            ty = (1 - sy) * 370
        elif original_width == 0:
            advance, sx, sy, tx, ty = 0, 0.9, 1, 0, 0
        else:
            advance = 1000 if unicodedata.east_asian_width(chr(cp)) in "WF" else 500
            # Fixed cells and explicit non-ligating code glyphs.
            sx = 0.9 if 0x20 <= cp <= 0x7E else advance / original_width
            sy, tx, ty = 1, (advance - original_width * sx) / 2, 0
        matrix = (sx, 0, 0, sy, tx, ty)
        key = (source, old, matrix, advance)
        if key not in keys:
            name = f"g{len(keys) + 1}"
            keys[key] = name
            glyph = draw(source, old, matrix)
            glyphs[name] = glyph
            glyph.recalcBounds(glyphs)
            metrics[name] = (advance, getattr(glyph, "xMin", 0))
        cmap[cp] = keys[key]
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(list(glyphs))
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=1020, descent=-300, lineGap=0)
    fb.setupOS2(sTypoAscender=1020, sTypoDescender=-300, sTypoLineGap=0,
               usWinAscent=1250, usWinDescent=500, usWeightClass=400,
               usWidthClass=5, fsSelection=0x40, fsType=0,
               sxHeight=550 if kind == "mono" else 497,
               sCapHeight=730 if kind == "mono" else 711)
    ps = family.replace(" ", "") + "-Regular"
    fb.setupNameTable({"familyName": family, "styleName": "Regular",
                       "uniqueFontIdentifier": ps + ";0.100",
                       "fullName": family + " Regular", "psName": ps,
                       "version": "Version 0.100; review prototype",
                       "copyright": COPYRIGHT,
                       "description": f"OFL-derived {kind} font with {cjk_style} CJK. "
                                      "Kai CJK from LXGW WenKai; sans CJK from Maple Mono CN. "
                                      "Reading Latin from Libertinus Sans; mono Latin from Maple Mono CN. "
                                      "No Claudaco or Optima outlines.",
                       "licenseDescription": OFL,
                       "licenseInfoURL": "https://openfontlicense.org/"})
    fb.setupPost(isFixedPitch=1 if kind == "mono" else 0)
    fb.setupMaxp()
    output = args.output_dir / (ps + ".ttf")
    fb.save(output)
    outline.cache_clear()
    del fb, glyphs, metrics, cmap, keys
    font = TTFont(output)
    final_cmap = font.getBestCmap()
    widths = {ch: font["hmtx"][final_cmap[ord(ch)]][0] for ch in "MWil01中文"}
    if kind == "mono":
        assert all(font["hmtx"][final_cmap[cp]][0] == 500 for cp in range(0x20, 0x7f))
        assert all(font["hmtx"][name][0] == 1000 for cp, name in final_cmap.items() if 0x4E00 <= cp <= 0x9FFF)
    font.flavor = "woff2"
    if kind == "reading" and cjk_style == "sans":
        # Keep the default GUI face complete, but avoid outline reconstruction
        # on the WebView's startup path. Other faces retain their encoding.
        font.flavorData = WOFF2FlavorData(transformedTables=set())
    font.save(ROOT / (ps + ".woff2"))
    receipt = {
        "family": family, "kind": kind, "cjkStyle": cjk_style, "file": output.name,
        "bytes": output.stat().st_size,
        "unicodeMappings": len(final_cmap),
        "hanIdeographs": sum(0x4E00 <= cp <= 0x9FFF for cp in final_cmap),
        "sampleAdvances": widths,
        "license": "OFL-1.1", "previewSubset": False,
        "cjkSource": "Maple Mono NL CN v7.9 (Resource Han Rounded)" if cjk_style == "sans" else "LXGW WenKai v1.522 for mapped CJK; Maple for remaining symbols",
        "limitations": ["Regular only", "No handcrafted small-size hinting",
                        "Rebuilt Unicode outlines; donor GSUB and GPOS are not included",
                        "No native terminal or cross-platform acceptance"]
    }
    print(json.dumps(receipt, ensure_ascii=False), flush=True)
    return receipt


if __name__ == "__main__":
    receipt = build(*VARIANTS[args.variant])
    (args.output_dir / f'{args.variant}.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
