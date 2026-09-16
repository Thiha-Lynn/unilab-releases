# Install UniLab 0.3.0

Website: https://unilab.ztvmm.live/
Release: https://github.com/Thiha-Lynn/unilab-releases/releases/tag/v0.3.0

| Device | Package | Notes |
|---|---|---|
| Android 10+ | `UniLab-0.3.0-android.apk` | Signed universal APK; current Android System WebView required. Your device may ask permission to install from the browser/file manager. |
| Apple Silicon Mac | `mac-arm64.dmg` or `.zip` | Current supported macOS; unsigned and not notarized. |
| Intel Mac | `mac-x64.dmg` or `.zip` | Current supported macOS; unsigned and not notarized. |
| Windows Intel/AMD | `win-x64.exe` | Windows 10/11 x64; unsigned preview. |
| Windows ARM | `win-arm64.exe` | Windows on ARM; unsigned preview. |
| Linux Intel/AMD | `linux-amd64.deb` / `linux-x86_64.AppImage` | Current Debian/Ubuntu or compatible 64-bit desktop. |
| Linux ARM | `linux-arm64.deb` / `.AppImage` | Current ARM64 Linux desktop. |
| iPhone / iPad | Installable web app | Safari → Share → Add to Home Screen. No native IPA or App Store release. |
| Chromebook / other current browser | Installable web app | Browser menu → Install / Add to home screen, where supported. |
| Self-host / portable web | `UniLab-0.3.0-web.zip` | Extract and run `node serve.cjs`; open the printed localhost URL. Node 22+ required. Do not open index.html directly as a file. |

Desktop filenames begin with `UniLab-0.3.0-`. Check your processor before downloading. Linux DEB: install using the distribution's package manager; AppImage: mark executable, then open. Some distributions need FUSE compatibility libraries. Do not run as root or disable the Electron sandbox. If an unsigned desktop app is blocked, use the web version; we do not instruct users to disable system protections.

## Offline operation

APK, desktop and portable-web distributions contain the app, OCR worker/WASM engines, all 19 offered OCR languages, and CPU/GPU background-removal model/runtime assets. They do not require a network connection to initialize those tools. Packages are substantially larger than the hosted app's core because these assets and desktop browser engines are included.

On the hosted web/PWA version, select **Make UniLab work offline** and wait for confirmation before disconnecting. Core cache is under 8 MB. OCR and background removal still need online engine/model/language downloads on first use. Browser storage eviction can remove cached assets. Installing a PWA does not give it the APK's bundled assets.

Files are processed on your device. Android exports use the system **Save** dialog; choose a local device folder for offline saving. A cloud provider selected in that dialog may sync the file. PDF recipients need only a PDF viewer, not UniLab.

## Platform limits and testing

Android requires a current WebView, WebAssembly and modern JavaScript; old or vendor-disabled WebViews are not supported. Screen recording, codecs, camera and microphone depend on the OS/browser. Large media files can exceed a phone's memory. Prefer one file at a time. The APK does not request broad storage access.

CI runs 28 app tests, two desktop policy tests, the production build and offline asset integrity checks; it compiles each desktop target and Android and runs Android lint. Responsive desktop browser checks supplement these tests. Native builds are previews and have not all been exercised on physical Windows/Linux/Android devices. Real-device recording, accessibility, battery, long-job performance and output quality across every tool remain validation work. No universal device or format compatibility is promised.

There is no automatic updater. Download new versions from the release page. Keep Android's existing install to update using the same signing certificate. Source modifications can be built and signed with your own key under the included open-source licenses.

## Verify downloads

Compare SHA-256 with `SHA256SUMS.txt` (`shasum -a 256`, `sha256sum`, or PowerShell `Get-FileHash`). Android's public certificate fingerprint is in `ANDROID-SIGNING-CERTIFICATE.txt`. Only download releases from this project's repository. SHA-256 checks detect corruption; they do not replace operating-system code signing.
