#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node qa/make-fixtures.mjs
ffmpeg -y -f lavfi -i 'testsrc2=size=320x240:rate=15:duration=3' -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=3' -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest qa/fixtures/video.mp4
ffmpeg -y -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=3' qa/fixtures/audio.wav
ffmpeg -y -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=4' -af "volume=enable='between(t,1,3)':volume=0" qa/fixtures/gaps.wav
magick qa/fixtures/image.png qa/fixtures/image.heic
python3 - <<'PY'
from pypdf import PdfReader, PdfWriter
w=PdfWriter()
for p in PdfReader('qa/fixtures/document.pdf').pages:w.add_page(p)
w.encrypt('unilab-test')
with open('qa/fixtures/locked.pdf','wb') as f:w.write(f)
PY
