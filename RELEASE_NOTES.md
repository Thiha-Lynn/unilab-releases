# UniLab 0.2.0 preview

HTML lecture-to-PDF, 59 local-processing tools, social-sharing image previews,
install instructions and the first desktop distributions. Application source and
build provenance are recorded in source-lock.json. The hosted release is
https://unilab.ztvmm.live/ and mobile installation is explained at
https://unilab.ztvmm.live/#/install.

## Packages

macOS (Intel / Apple Silicon) DMG and ZIP; Windows (x64 / ARM64) installers;
Linux (x64 / ARM64) AppImage and Debian packages; portable web ZIP. Android,
iPhone and iPad use the installable web app. **No APK or IPA is included.**
Desktop packages are **unsigned, unnotarized previews**. Use the hosted app if
your OS refuses a package. Current 64-bit OS versions are recommended; no legacy
OS compatibility or physical-device certification is claimed.

Linux filenames use `x86_64` for Intel/AMD AppImage and `amd64` for Intel/AMD Debian packages; both refer to the x64 CPU family. The ARM files use `arm64`.

## Verification record

- 27 local source tests passed (25 portable tests plus two local lecture fixtures).
  The 25 portable tests and production-build gate passed in CI. Core offline size:
  7,402,384 bytes, below the 8,000,000-byte limit.
- Two desktop boundary policy tests passed on each of the six build runners.
- All six platform package jobs passed. The initial publication inventory check
  rejected Linux CPU aliases; the corrected publication workflow verifies the
  successful build run and reuses its immutable artifacts.
- CI produces every named package, then checks the complete package inventory and
  generates SHA256SUMS.txt. Checksums verify bytes, not publisher code signing.
- Browser UI: installation page checked at 320, 390, 768 and 1440 px. No horizontal
  overflow in the measured layouts; overlapping button spacing was fixed.
- macOS Apple Silicon interactive smoke check: packaged app launched, opened a
  local lecture HTML, rendered 18 slides, converted and saved a 4,696,676-byte
  18-page PDF through the native Save dialog. Pages 2 and 18 rendered clearly
  in independent Poppler inspection. Phone handoff was corrected to the public
  HTTPS tool URL after this check.
- Safari on macOS also converted and downloaded the 18-slide lecture: valid
  18-page PDF, 5,962,837 bytes. Pages 2 and 18 rendered legibly in independent
  inspection. Shadows differ slightly between engines; content and layout remain.
- Live production: 99 asset hashes, correct MIME types, camera/mic policy, and
  source revision verified. Social PNG returns HTTP 200 with image/png, and
  crawler-style HTML requests include all Open Graph and Twitter tags.
- Earlier same-day source checks: all 59 routes loaded, lecture PDF exports and
  PDF compression completed, raster redaction output was inspected, core offline
  conversion succeeded. These checks are not an all-tools processing matrix.

Physical iOS/Android phones, Windows/Linux interactive runs, all codecs, all tool
workflows and all accessibility combinations have not been tested. Recording and
optional AI/OCR downloads depend on device support and permission. The course's
instructor approval and team scope decisions remain pending separately.
