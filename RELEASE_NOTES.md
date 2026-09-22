UniLab 0.3.1 refreshes the app with local line icons, a restrained light/dark palette, clearer status labels, accessible category selection, keyboard focus outlines and matching web, Android and social artwork. Signed Android and offline desktop packages remain supported. Android exports use the system Save dialog with bounded memory transfer and no temporary output copy. The UI accounts for Android system bars and keyboards.

The open-source application now lives in this release repository. Builds use its own pinned revision; coursework and assignment evidence remain in the separate `Thiha-Lynn/unilab` repository.

Downloads: Android APK; macOS DMG/ZIP, Windows EXE and Linux DEB/AppImage for x64 and ARM64; portable web ZIP. All native/portable bundles include 19 OCR languages and the background-removal model. The hosted PWA retains its under-8-MB core cache. iPhone/iPad use the PWA, with optional assets downloaded online on first use; no native IPA is included.

Validation gates: 28 application tests, two desktop policy tests, production build and core-size budget, integrity verification of every offline data file, seven native build targets, Android lint and APK asset inspection. These checks do not certify every tool on every physical device. Android/Windows/Linux physical-device testing, long-job performance, and real-device recording/accessibility remain open.

Desktop packages are unsigned/unnotarized previews; Android is signed with the project's release certificate. No automatic updater. Modern OS/browser engines are required. See INSTALL.md for platform-specific instructions and limits.

The combined distribution is AGPL-3.0-only because it includes IMG.LY background-removal. Original MIT and dependency notices are preserved. The corresponding UniLab source is in this tag's source archives; the unmodified background-removal source archive is provided as an additional asset. See THIRD_PARTY.md.

HTML-to-PDF, social sharing metadata, local-file privacy protections and mobile layout improvements from 0.2.0 remain included. Converted HTML PDFs use rendered page images; use Print / Save as PDF for selectable text where supported. Interactive lecture scripts and external resources are intentionally excluded.

Prior 0.3.0 bundled-browser smoke checks completed with external HTTPS blocked: English OCR recognized a synthetic scanned PDF correctly, and CPU background removal produced a preview. GPU acceleration is disabled in this release because failed GPU initialization prevented a reliable CPU retry. CPU inference can pause the interface on slower devices.

For 0.3.1, 28 application tests and two desktop tests pass. Browser checks cover search, category selection, lecture-tool navigation, installation instructions, keyboard focus, light/dark themes and 320/390/768/1440 px layouts. These are browser checks, not new physical-device certification.
