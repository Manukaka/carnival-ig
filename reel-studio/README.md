# Carnival Reel Studio

On-brand animated Instagram reels (1080×1920, 30 fps) for Carnival Enterprises.
HTML + GSAP templates rendered frame-by-frame with Playwright, plus an original generated music bed.

```bash
cd reel-studio && npm ci
python3 music.py out/intro.wav 16.8 hits=0.15,14.4 whoosh=2.4,7.2,12.0
node render.mjs templates/brand-intro.html out/brand-intro.mp4 30 out/intro.wav
```

- `templates/` — one HTML file per reel; exposes `window.DURATION`, `window.seek(t)`, `window.ready`.
- `assets/` — Carnival logo (from Canva brand kit) and monogram.
- `music.py` — royalty-free music generator (100 bpm, bar = 2.4 s), hits + whooshes on scene changes.
