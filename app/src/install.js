import { el } from './ui.js';

export function renderInstall(app) {
  document.title = 'Install & downloads — UniLab';
  const release = `https://github.com/Thiha-Lynn/unilab-releases/releases/tag/v${__APP_VERSION__}`;
  app.appendChild(el(`<main class="wrap privacy-page">
    <a class="backlink" href="#/">← All tools</a>
    <header class="hero"><p class="note">UniLab v${__APP_VERSION__}</p>
      <h1>Your tools, on your device.</h1>
      <p>Use UniLab in your browser, install it on your home screen, or download an Android or desktop app. Your files are processed locally in every version.</p>
      <a class="btn" href="#/">Use UniLab now</a>
    </header>
    <div class="install-grid">
      <section class="install-card"><h2>iPhone &amp; iPad</h2>
        <p>Open <a href="https://unilab.ztvmm.live/">unilab.ztvmm.live</a> in Safari. Tap <b>Share → Add to Home Screen → Add</b>. If offered, keep <b>Open as Web App</b> enabled.</p>
        <p>The home-screen app opens without a browser address bar. Save exported PDFs in Files to read them in any PDF viewer.</p>
        <p class="note">Mobile web app. No App Store installation or IPA is required.</p>
      </section>
      <section class="install-card"><h2>Android</h2>
        <p>Open UniLab in Chrome. Open the browser menu and choose <b>Add to Home screen</b> or <b>Install app</b>, then confirm.</p>
        <p>Downloaded files go to your device’s Downloads folder. You can open or share them from your file manager.</p>
        <p class="note"><a class="btn secondary" href="https://github.com/Thiha-Lynn/unilab-releases/releases/download/v${__APP_VERSION__}/UniLab-${__APP_VERSION__}-android.apk">Download Android APK</a> Android 10+ with an up-to-date Android System WebView. The APK opens a system Save dialog for exports. No Play Store account is needed.</p>
      </section>
      <section class="install-card"><h2>macOS · Windows · Linux</h2>
        <p>Desktop preview packages include the app and its browser engine. Choose the file for your operating system and processor on the release page.</p>
        <a class="btn secondary" href="${release}" target="_blank" rel="noopener">Desktop downloads &amp; checksums ↗</a>
        <p class="note">Unsigned preview builds may be blocked by your OS. Use the web app if you prefer. There is no automatic updater; get new versions from the release page.</p>
      </section>
      <section class="install-card"><h2>Chromebook &amp; other devices</h2>
        <p>Use a current browser with JavaScript and file downloads. Chrome and Edge may offer an install button in the address bar or menu. On a Mac, Safari also offers <b>File → Add to Dock</b>.</p>
        <p>A PDF exported by UniLab needs only a PDF viewer — the recipient does not need UniLab.</p>
      </section>
    </div>
    <section class="install-card"><h2>Ready before you go offline</h2>
      <p>On the <a href="#/">tools page</a>, choose <b>Make UniLab work offline</b> and wait for confirmation. Core tools use less than 8 MB. OCR and background removal need additional downloads while online. Android APK and desktop packages bundle the core tools, OCR engine with all 19 language packs, and the background-removal model. These packages work offline from the first launch. They are larger because they include those assets.</p>
      <h2>Choose the right tool for your device</h2>
      <p>PDF, image and text tools are a good starting point on phones. Large files need more memory; try one file at a time. Video formats, screen capture, camera and microphone depend on your browser and OS. Recording asks for permission when you use it; screen recording may be unavailable on mobile.</p>
      <p>HTML to PDF offers original layout or a reading layout. Downloaded PDFs contain page images; use Print / Save as PDF when you need selectable text. External images, scripts and interactive content in a lecture may not appear.</p>
      <p class="note">Native builds are previews. Build checks and responsive browser checks do not mean every tool has been tested on every physical device. See the <a href="${release}" target="_blank" rel="noopener">release notes</a> for the current testing record.</p>
    </section>
  </main>`));
}
