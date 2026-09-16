import QRCode from 'qrcode';
import { el, downloadBlob, canvasToBlob } from '../ui.js';

export default function render(container) {
  const panel = el(`
    <div class="panel">
      <div class="pills" style="margin-top:0;justify-content:flex-start">
        <button class="pill active" data-tab="text">🔗 Link / text</button>
        <button class="pill" data-tab="wifi">📶 Wi-Fi</button>
      </div>
      <div data-pane="text">
        <div class="field">
          <label>Link or text</label>
          <input type="text" data-text placeholder="https://… or any text" />
        </div>
      </div>
      <div data-pane="wifi" hidden>
        <div class="controls">
          <div class="field" style="flex:1"><label>Network name (SSID)</label><input type="text" data-ssid /></div>
          <div class="field" style="flex:1"><label>Password</label><input type="text" data-pass /></div>
          <div class="field"><label>Security</label>
            <select data-sec><option value="WPA">WPA/WPA2</option><option value="WEP">WEP</option><option value="nopass">Open</option></select>
          </div>
        </div>
      </div>
      <div class="controls">
        <div class="field"><label>Size</label>
          <select data-size><option value="256">256 px</option><option value="512" selected>512 px</option><option value="1024">1024 px</option></select>
        </div>
      </div>
      <div style="text-align:center;margin-top:18px">
        <canvas data-canvas style="max-width:min(320px,100%);border:1px solid var(--line);border-radius:12px;background:#fff"></canvas>
        <div class="actions" style="justify-content:center">
          <button class="btn" data-dl disabled>⬇ Download PNG</button>
        </div>
      </div>
    </div>
  `);

  const canvas = panel.querySelector('[data-canvas]');
  const dlBtn = panel.querySelector('[data-dl]');
  let activeTab = 'text';

  panel.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      activeTab = b.dataset.tab;
      panel.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      panel.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== activeTab));
      update();
    })
  );

  function payload() {
    if (activeTab === 'wifi') {
      const ssid = panel.querySelector('[data-ssid]').value.trim();
      if (!ssid) return '';
      const sec = panel.querySelector('[data-sec]').value;
      const esc = (s) => s.replace(/([\\;,:"])/g, '\\$1');
      const pass = panel.querySelector('[data-pass]').value;
      return `WIFI:T:${sec};S:${esc(ssid)};${sec === 'nopass' ? '' : `P:${esc(pass)};`};`;
    }
    return panel.querySelector('[data-text]').value.trim();
  }

  async function update() {
    const data = payload();
    if (!data) {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      dlBtn.disabled = true;
      return;
    }
    const size = Number(panel.querySelector('[data-size]').value);
    await QRCode.toCanvas(canvas, data, { width: size, margin: 2, errorCorrectionLevel: 'M' });
    dlBtn.disabled = false;
  }

  panel.querySelectorAll('input, select').forEach((i) => i.addEventListener('input', update));
  dlBtn.addEventListener('click', async () => {
    downloadBlob(await canvasToBlob(canvas, 'image/png'), 'unilab-qr.png');
  });

  container.appendChild(panel);
  container.appendChild(el(`<p class="note">Put a QR on the first slide so the class can grab your group’s doc instantly — or share dorm Wi-Fi without spelling the password.</p>`));
}
