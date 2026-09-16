# UniLab

Private PDF, image, audio, video and text tools. Use [UniLab online](https://unilab.ztvmm.live/) or get the [platform packages](https://github.com/Thiha-Lynn/unilab-releases/releases).

This is the independent **open-source product and release repository**. Application source lives in `app/`, the desktop shell in `desktop/`, and the Android app in `mobile/`. Builds do not check out or depend on the assignment repository. Academic requirements, interviews, lecturer material and submission evidence stay in the separate [assignment repository](https://github.com/Thiha-Lynn/unilab). `source-provenance.json` records the original import.

## Version 0.3.0

- Android 10+ APK with a native system Save dialog, bundled offline assets and system-bar/keyboard spacing.
- macOS DMG/ZIP, Windows EXE, Linux DEB/AppImage, each for Intel/AMD x64 and ARM64.
- iPhone/iPad and other current browsers: installable web app. There is no native IPA in this release.
- Native packages include all 19 OCR language packs and the background-removal model for first-launch offline use. The hosted web app keeps its core offline cache below 8 MB; optional engines need an online first use.
- HTML lectures to readable PDF, original-layout preview, local-only conversion, Open Graph/social preview metadata.

Read [INSTALL.md](INSTALL.md) for processor selection, limitations and installation. Native packages are previews: desktop packages are unsigned/unnotarized; Android APKs are signed with the project's release key. Build success is not physical-device certification.

## Development and reproducible builds

Use Node 24 and npm. In `app/`, run `npm ci`, `npm test`, then `npm run dev` or `npm run build`. At repository root, run `npm test`, `npm run prepare:web`, and `npm run bundle:offline`. Bundling checks every downloaded model against `offline/assets.lock.json`. This downloads about 90 MB of model/runtime/language data, plus local OCR engines.

Desktop: run `npm ci` at the root, then `npm run package -- --mac --arm64` (or `--win/--linux` and `--x64/--arm64`). Use the matching operating system for release builds.

Android: Java 21, Android SDK 36/build-tools 36.0.0. Run `npm ci` and `npx cap sync android` in `mobile/`, then `./gradlew testReleaseUnitTest lintRelease assembleRelease` in `mobile/android/`. Sign the unsigned APK with your own key using Android `apksigner`. Private production keys are outside this repository and are provided to tag workflows as GitHub secrets.

The protected pull-request workflow tests the app, verifies the offline bundle, and compiles all seven native targets. A matching `vX.Y.Z` tag builds packages, verifies their complete inventory and hashes, signs the APK, and creates a draft GitHub release. Publish only after reviewing the checks. Download `SHA256SUMS.txt` and `ANDROID-SIGNING-CERTIFICATE.txt` with packages.

Production deploy: `cd app && ./deploy.sh` uses a clean checked-out revision, tests, verifies file hashes and atomically promotes the release on the configured UniLab host. Assignment Pages remains a separate coursework preview.

## License and source

The combined distribution is AGPL-3.0-only, including the unmodified IMG.LY background-removal dependency. Original MIT notices are retained in `LICENSE-MIT`. See [THIRD_PARTY.md](THIRD_PARTY.md), bundled dependency notices and the upstream source archive attached to releases. Your documents remain yours. No warranty is provided.
