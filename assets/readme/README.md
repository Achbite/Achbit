# README media

`achbit-overview.html` is the editable source for a 24-second, four-chapter product overview. Open it locally in a browser. It has playback, timeline, chapter, and English/Chinese controls; `?lang=zh` selects Chinese. Keep it beside the existing screenshot and `../brand/ac-mark.png`. It makes no network requests and does not start Achbit.

The GUI panels use the existing `achbit-computer-use-en.png` screenshot. The checklist interactions, terminal commands, and extension diagram are editorial illustrations of documented behavior, not a screen recording of a new agent run. README captions preserve that distinction.

Exports:

- `achbit-overview-en.gif` / `achbit-overview-zh.gif`: looping 1024 × 640 animations for GitHub README.
- `achbit-overview-en.mp4` / `achbit-overview-zh.mp4`: 1280 × 800 H.264 video versions.
- `achbit-overview-poster.png`: a still frame for previews.

## Regenerate

Use the project Docker container with Chromium, FFmpeg, and `playwright-core` installed in a temporary authoring directory. The renderer has no project package dependencies and does not run product tests.

```sh
NODE_PATH=/tmp/achbit-readme-media/node_modules \
ACHBIT_MEDIA_FRAMES=/workspace/.build-cache/readme-overview-frames \
node assets/readme/render-overview.cjs
bash assets/readme/export-overview.sh
```

The renderer accepts `CHROMIUM_BIN`, `ACHBIT_MEDIA_LANGUAGES=en,zh`, and `ACHBIT_MEDIA_PREVIEW=1` (four key frames only). Working PNG frames and palettes stay in `.build-cache/`; only the intended media assets belong in a commit.
