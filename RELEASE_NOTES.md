UniLab 0.4.1 prepares the four field-study workflows for public use:

- Slides cleanup: compress toward a decimal KB/MB limit, convert to grayscale, and rotate selected upside-down pages by 180 degrees.
- Mixed-file assembly: combine PDFs, JPGs and PNGs in selection order, fitting images onto A4 pages and stripping image metadata.
- Sign and protect: place a drawn signature and optionally require a 12–64-character ASCII password, using AES-256 PDF encryption. Password fields clear after success.
- Page extraction: export a selected page range, including one page from a large PDF.

Anonymous first-party reporting now includes daily UTC totals and CSV exports for sessions, locally selected files, completed jobs, errors and download requests. Public aggregate exports omit pilot codes and feedback. Sessions are not verified people; a separate opt-in study and organiser verification establish distinct participants. Files remain on the device, with no document-content upload. DNT/GPC and opt-out are respected; events expire after 30 days. Offline events are not queued.

Validation: 37 application regression tests, 7 collector/dashboard tests, 2 desktop policy tests, and synthetic browser checks of all four workflows. The production build enforces an 8 MB core cache budget. The PDF fixtures and their size padding are documented; synthetic checks are not real-user evidence. Live release verification is recorded separately after deployment.

All existing tools, including Markdown to PDF/EPUB/web book with Burmese and Thai fonts, remain available. New qpdf runtime and dependency licenses are bundled. Native and portable packages include OCR languages and the background-removal model; the hosted PWA downloads optional engines on first use.

Native packages remain previews: desktop is unsigned/unnotarized; Android is signed with the project certificate. Physical-device compatibility, accessibility and the real participant study still require field testing. Download requests do not prove the browser saved a file. A moderate advisory remains in Mammoth's command-line-only argparse/sprintf dependency; its CLI is not invoked by the browser path.

Downloads include Android APK; macOS, Windows and Linux x64/ARM64 packages; portable web ZIP. iPhone/iPad use the PWA. See INSTALL.md. Distribution is AGPL-3.0-only with dependency notices retained, and source archives accompany the tag.
