#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRAMES="${ACHBIT_MEDIA_FRAMES:-$ROOT/.build-cache/readme-overview-frames}"
for language in en zh; do
  ffmpeg -hide_banner -loglevel error -y -framerate 12 -i "$FRAMES/$language/frame-%04d.png" \
    -vf 'fps=10,scale=1024:640:flags=lanczos,palettegen=stats_mode=diff' \
    -frames:v 1 "$FRAMES/$language/palette.png"
  ffmpeg -hide_banner -loglevel error -y -framerate 12 -i "$FRAMES/$language/frame-%04d.png" \
    -i "$FRAMES/$language/palette.png" \
    -filter_complex '[0:v]fps=10,scale=1024:640:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle' \
    -loop 0 -gifflags +transdiff "$ROOT/assets/readme/achbit-overview-$language.gif"
  ffmpeg -hide_banner -loglevel error -y -framerate 12 -i "$FRAMES/$language/frame-%04d.png" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -r 24 -movflags +faststart \
    "$ROOT/assets/readme/achbit-overview-$language.mp4"
  printf '%s: GIF and MP4 exported\n' "$language"
done
cp "$FRAMES/en/frame-0030.png" "$ROOT/assets/readme/achbit-overview-poster.png"
