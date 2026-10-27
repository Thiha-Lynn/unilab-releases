# Browser acceptance evidence

After `npm ci`, run `bash qa/prepare-fixtures.sh` (requires ffmpeg, ImageMagick with HEIC support, and Python pypdf). Run `npm run dev -- --port 4174` and open `/qa/`. Press **Run all tool checks**, then export JSON. Fixtures contain no personal data. The QA directory is excluded from the production Vite build and generated fixtures/results are ignored by Git.

The harness drives actual tool controls in an iframe and decodes downloaded PDFs/images/media. Output presence is not a claim of visual perfection or exhaustive option coverage. PDF rasterisation, OCR accuracy, background cutout quality, EPUB reader interoperability, long-file performance and all native devices need representative manual samples too.

Recorder checks replace capture devices with a generated tone and canvas stream. They test record/stop/export mechanics without microphone access or screen sharing. They do not certify physical devices or permission dialogs. QA/local origins never send usage events and must not be included in real-participant counts.

The revision field identifies the checked-out base commit when development files are uncommitted. The dated evidence committed with this change was captured from the accompanying working tree, not the old public release. Record the final release tag separately when presenting it.

## November field-task checks

Run `node qa/make-uat-fixtures.mjs`, then `npm run build` and `npm run dev -- --host 127.0.0.1 --port 4174`. Open `/qa/uat.html?built=1` and run the four checks against the built `dist/` app. The harness verifies grayscale/orientation and the decimal 5 MB cap, mixed PDF/JPG/PNG page order, drawn signing plus password rejection/acceptance, and page 42 extraction from 120 pages. Export its JSON and inspect the displayed page previews. Each frame gets a fresh navigation and QA mode excludes it from public usage.

The 15 MB slide fixture includes deterministic comment padding, so its compression ratio is not a representative benchmark. All fixtures are fictional. Browser validation does not replace target-device UAT or prove the absence of every network channel. The harness checks request bodies through window.fetch; audit the browser network panel separately on real devices.
