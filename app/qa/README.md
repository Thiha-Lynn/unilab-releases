# Browser acceptance evidence

After `npm ci`, run `bash qa/prepare-fixtures.sh` (requires ffmpeg, ImageMagick with HEIC support, and Python pypdf). Run `npm run dev -- --port 4174` and open `/qa/`. Press **Run all tool checks**, then export JSON. Fixtures contain no personal data. The QA directory is excluded from the production Vite build and generated fixtures/results are ignored by Git.

The harness drives actual tool controls in an iframe and decodes downloaded PDFs/images/media. Output presence is not a claim of visual perfection or exhaustive option coverage. PDF rasterisation, OCR accuracy, background cutout quality, EPUB reader interoperability, long-file performance and all native devices need representative manual samples too.

Recorder checks replace capture devices with a generated tone and canvas stream. They test record/stop/export mechanics without microphone access or screen sharing. They do not certify physical devices or permission dialogs. QA/local origins never send usage events and must not be included in real-participant counts.

The revision field identifies the checked-out base commit when development files are uncommitted. The dated evidence committed with this change was captured from the accompanying working tree, not the old public release. Record the final release tag separately when presenting it.
