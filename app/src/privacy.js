// The privacy page.
//
// rule.md, PDPA 25: "The system must ship a privacy page, in plain English, stating
// what is processed, where it is processed, what is held and for how long, what is
// fetched from the network and why, and how to erase a result — one screen, not
// twelve pages, and not copied from another product."
//
// Those six questions are the six headings below, in that order, and nothing else is
// here. The temptation with a privacy page is to write the long defensive one every
// other site has; that page exists to protect its author, and rule.md rules it out
// twice — "one screen" and "not copied from another product".
//
// Every claim on this page is checked by something. Where a statement is provable by
// a test or by reading a specific file, the page says which — because rule.md PDPA 24
// forbids a privacy claim the code does not enforce, and a claim the reader can verify
// is worth more than a promise they have to accept.

import { bundledOffline } from './offline-assets.js';
import { el } from './ui.js';
import { TTL_MINUTES } from './vault.js';
import { describeLimit, MAX_FILE_BYTES } from './intake.js';

export function renderPrivacy(app) {
  const wrap = el(`<div class="wrap privacy-page"></div>`);

  wrap.appendChild(el(`
    <header class="privacy-page__head">
      <a class="back" href="#/">← All tools</a>
      <h1>Privacy</h1>
      <p class="lede">UniLab processes your documents on your device. Small usage counts are separate from your files.</p>
    </header>
  `));

  wrap.appendChild(el(`
    <section class="privacy-page__body">

      <h2>What is processed</h2>
      <p>Whatever file you choose — a PDF, an image, a video, an audio recording — plus the
      options you set for the tool, such as a target size or a page range. Usage events and optional pilot feedback are described below.
      There is no account, so there is no name, email or phone number to process.</p>

      <h2>Where it is processed</h2>
      <p><b>On your own device, inside the browser or app window.</b> Your file is never uploaded.
      There is no server that receives document files and no document-upload endpoint anywhere in the code —
      not switched off, not restricted: absent.</p>
      <p class="check">You can check this yourself: open your browser's developer tools,
      go to the Network tab, and run any tool. No request carries your file.</p>

      <h2>What is held, and for how long</h2>
      <p>The selected source and previews stay in this tab while you work. Download screens with a countdown hold finished results for <b>${TTL_MINUTES} minutes</b>, then clear their download URLs and references. <b>Clear files from memory</b> clears those finished results sooner. Other tool outputs stay until you leave or close the tab. Close the
      tab to release the source and previews too. Files are not saved to app storage;
      a copy you explicitly download stays on your device until you delete it. The Android app opens the system Save dialog and streams the result directly to the location you choose; it does not keep a temporary export copy. A cloud provider chosen in that dialog may sync your saved file.</p>
      <p class="check">Automated tests check result URL revocation and released blob references.
      Browser memory reclamation is controlled by the browser; this is not secure erasure
      of your original file or downloaded copies.</p>

      <h2>What is fetched from the network, and why</h2>
      ${bundledOffline() ? '<p>This package includes the app, OCR engine, all 19 language packs and background-removal model. Tools read these assets locally, without a network download.</p>' : `<p>App code, bundled fonts, and — for two tools — a program the tool needs in order to
      run on your device:</p>
      <ul>
        <li><b>OCR</b> downloads a recognition engine and the language packs you pick.</li>
        <li><b>Remove Background</b> downloads its model the first time you use it.</li>
      </ul>
      <p>Both say what they will download, and roughly how large, <b>before</b> starting.
      What is fetched is program code and model data. <b>Your file is never part of a
      request</b> — the model comes to your file, not the other way round.</p>`}

      <h2>How to erase a result</h2>
      <p>Press <b>Clear files from memory</b> on the download screen, or close the tab. Both drop the
      result from the current view. This does not delete files already saved on your device. Pilot records expire after 30 days; contact the project with your invitation code for earlier deletion.</p>

      <h2>Cookies, ads and analytics</h2>
      <p>No analytics cookies. No advertising, no tracking pixels, no third-party scripts
      that watch you. The hosting server receives ordinary requests for app assets, including your IP address
      and browser headers. It does not receive the files you process.</p>

      <h2>Optional pilot and usage counts</h2><p>We collect small first-party usage events: tool names, completed jobs, locally selected and successfully processed input-file counts and download requests. No files, filenames, entered text or raw error messages are sent. A random identifier in local storage is renewed each UTC day to count daily browser/app instances, not people. The server keeps only a day-specific keyed hash. A separate random session identifier estimates sessions; counter records expire after 30 days. You can disable ordinary counts, and browser Do Not Track/Global Privacy Control are respected. A separate opt-in pilot links activity and task feedback to an invitation code for 30 days. <a href="#/pilot">Manage usage counts and pilot participation</a>.</p><h2>Limits worth knowing</h2>
      <ul>
        <li>Each tool states its file count and size limit (at most ${describeLimit(MAX_FILE_BYTES)}); files the tool
        cannot open are refused and not read.</li>
        <li>Because the work happens on your device, a large video is bounded by how fast
        that device is. We cannot promise server speed, and we do not.</li>
        <li>Installing UniLab for offline use stores the <i>app</i> on your device. It
        never stores your document files. GPA course names and grades are saved locally until you press Clear all. Usage preferences, a random identifier for the current UTC day and an optional pilot invitation are also saved locally.</li>
      </ul>

      <h2>Open source</h2><p>Copyright © 2026 UniLab contributors. Distributed under <a href="./LICENSE.txt">AGPL-3.0</a>, without warranty. You may modify and redistribute under its terms. <a href="https://github.com/Thiha-Lynn/unilab-releases" target="_blank" rel="noopener">Get the complete UniLab source and build instructions</a>. Third-party licenses are preserved in the distribution.</p>
      <h2>Questions</h2>
      <p>UniLab is an open-source project. For a privacy question, or anything on this
      page you think is wrong, open an issue on
      <a href="https://github.com/Thiha-Lynn/unilab-releases/issues" target="_blank" rel="noopener">GitHub</a>
      The source is public, so you can check
      how the app works.</p>

    </section>
  `));

  app.appendChild(wrap);
}
