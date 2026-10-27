# Licensing and corresponding source

UniLab 0.4.0 is distributed under AGPL-3.0-only because it includes
IMG.LY background-removal. Original UniLab MIT notices are retained in
LICENSE-MIT; third-party components retain their own licenses. This does
not change the license of a user's input files or output documents.

Complete UniLab source and build scripts are in this repository, in the
source archives attached to the matching release tag. Locked dependency
versions and integrity values are in app/package-lock.json and
mobile/package-lock.json. Distributed packages contain licenses/ with
production dependency notices and a machine-readable inventory.

The unmodified background-removal 1.7.0 library's corresponding source is
https://github.com/imgly/background-removal-js/tree/12f56cc4f2a90d624e165a715748d22efc7a1d93
and its source archive is attached separately to this release. Its upstream
build instructions and lockfile are in that archive. The ISNET model and
ONNX Runtime are MIT-licensed according to IMG.LY's ThirdPartyLicenses.json.

OCR engines and trained language data come from Tesseract.js, tesseract.js-core,
and the @tesseract.js-data packages (Apache-2.0). offline/assets.lock.json
identifies every downloaded model/data file by versioned URL, SHA-256 and size.
The upstream language-data source is https://github.com/naptha/tessdata and
Tesseract source is https://github.com/tesseract-ocr/tesseract.

Electron packages include Electron/Chromium license notices. Android uses
Capacitor (MIT) and AndroidX (Apache-2.0); their sources are
https://github.com/ionic-team/capacitor/tree/8.5.2 and
https://android.googlesource.com/platform/frameworks/support/ respectively.
No signing key is required to build a modified app: use a key you own.


## PDF password protection

Uses @neslinesli93/qpdf-wasm 0.3.0 (ISC package metadata), a WebAssembly build of QPDF 12.2.0. The upstream build pins QPDF 856d32c610334855d30e96d25eb5f9636fb62f08, zlib 21767c654d31d2dccdde4330529775c6c5fd5389 and jpeg-turbo 7aa2a898c564041a24b09d0a6e780aaa632d08d3. Their notices are redistributed in third_party/qpdf and the built licenses/qpdf-runtime folder. Build source: https://github.com/neslinesli93/qpdf-wasm. The gzip asset is reproducibly generated from the locked npm package by app/scripts/prepare-qpdf.js; no remote runtime CDN is used. The disposable worker runs AES-256 encryption on-device.

Social-preview images remain deployed and hashed but are excluded from the offline tool cache; they are not needed to operate the tools.
