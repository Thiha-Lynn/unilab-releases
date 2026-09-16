# UniLab releases

Versioned desktop packaging for [UniLab](https://unilab.ztvmm.live), the private
student toolbox. Application source stays in [Thiha-Lynn/unilab](https://github.com/Thiha-Lynn/unilab).

[Download releases](https://github.com/Thiha-Lynn/unilab-releases/releases) ·
[Installation guide](INSTALL.md) · [Testing and limitations](RELEASE_NOTES.md)

This repository contains the Electron shell, reproducible build configuration,
source revision lock and release notes. No student lecture files, credentials,
signing identities, processed user files or generated installers are committed.

## Reproduce

Use Node 24. Clone the source repository into `source/` and check out the exact
revision in `source-lock.json`. Run `npm ci`, `npm test`, `npm run build` there
(with GITHUB_SHA unset or equal to that source revision). At this repository root,
run `npm ci`, `npm test`, `npm run prepare:web`, and `npm run package -- --mac --arm64`
(or `--win --x64`, `--linux --x64`, etc.). macOS packaging needs macOS; build each
OS with the provided GitHub Actions matrix. `npm start` launches the local shell.

The pipeline verifies the source SHA, all web-asset hashes, versions and expected
package inventory. Version tags produce a **draft prerelease** with SHA-256 sums;
publish only after inspecting results and updating the test record. Installation
packages are not a claim of physical-device testing or an App Store approval.

## Desktop boundary

Packaged app://unilab assets only. Sandboxed, isolated renderer without Node or a
privileged preload bridge. Permissions default-deny; recording devices require a
user prompt. New windows never inherit app privileges, and external navigation is
limited to the canonical website and GitHub in the system browser. Uploaded HTML
uses the source application's script-free sandbox and sanitization. No local web
server, file upload API, telemetry, account, or updater service is added.
