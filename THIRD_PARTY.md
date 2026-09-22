# Licensing and corresponding source

UniLab 0.3.1 is distributed under AGPL-3.0-only because it includes
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
