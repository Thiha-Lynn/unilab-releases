# UniLab 0.2.0 installation

The quickest installation on every supported device is the web app:
https://unilab.ztvmm.live/#/install

| Platform | Distribution | How to choose |
| --- | --- | --- |
| macOS | `mac-arm64.dmg` / `.zip`, `mac-x64.dmg` / `.zip` | Apple Silicon: arm64; Intel: x64 |
| Windows | `win-x64.exe`, `win-arm64.exe` | Most PCs: x64; Windows on ARM: arm64 |
| Linux | `linux-x64.AppImage` / `.deb`, `linux-arm64.AppImage` / `.deb` | Match your CPU; .deb is for Debian/Ubuntu |
| Android | Installable web app | Chrome menu → Add to home screen / Install app |
| iOS / iPadOS | Installable web app | Safari → Share → Add to Home Screen |
| ChromeOS / other modern browsers | Web app | Open site; install from browser menu where supported |
| Self-host / portable web source | `web.zip` | Unzip, run `node serve.cjs`, then open the displayed loopback address |

Names above are suffixes after `UniLab-0.2.0-`. Choose one distribution, not all.
Current supported OS releases and a 64-bit processor are recommended. No 32-bit,
legacy Windows, Android APK, signed iOS IPA, or app-store distribution is included.
The web ZIP is a ready-built website, not a native phone installer. Do not open
index.html using file://; browser security prevents several tool APIs there.

Desktop builds are unsigned previews and macOS builds are not notarized. Your OS
may warn or refuse installation. The hosted web app remains available without
changing OS protections. There is no automatic desktop updater: download the
next version explicitly. Uninstall using the normal operating-system mechanism;
files you saved yourself remain until you delete them.

Verify downloads with SHA256SUMS.txt (`shasum -a 256 FILE` on macOS,
`sha256sum FILE` on Linux, `Get-FileHash FILE -Algorithm SHA256` in PowerShell).
Match the filename and entire digest against the release checksum file.

Core tools are bundled in desktop downloads. On the web, choose “Make UniLab work
offline” on the home page and wait for success. OCR and background removal require
optional engine/model downloads. Device memory and browser codec support constrain
large video/media jobs. Desktop screen recording excludes system audio when using
the fallback window picker. Camera/mic and screen permissions are requested only
when a recording tool asks for them. Screen recording may not work on mobile.

Source files and results are held in renderer memory. Saving a download explicitly
writes it to your chosen location. Close the app to release unsaved work. A browser
engine is bundled, making desktop installers much larger than the <8 MB web core.
