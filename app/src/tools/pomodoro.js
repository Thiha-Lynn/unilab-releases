import { el } from '../ui.js';

const MODES = { focus: ['Focus', 25], short: ['Short break', 5], long: ['Long break', 15] };

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.9);
    osc.start();
    osc.stop(ctx.currentTime + 1);
  } catch { /* audio blocked — fine */ }
}

export default function render(container) {
  let mode = 'focus';
  let remaining = MODES.focus[1] * 60;
  let timer = null;
  let sessions = 0;

  const panel = el(`
    <div class="panel" style="text-align:center">
      <div class="pills" style="margin-top:0">
        <button class="pill active" data-mode="focus">🍅 Focus</button>
        <button class="pill" data-mode="short">☕ Short break</button>
        <button class="pill" data-mode="long">🌿 Long break</button>
      </div>
      <div class="timer-mode" data-modelabel>Focus</div>
      <div class="timer-display" data-display>25:00</div>
      <div class="actions" style="justify-content:center">
        <button class="btn" data-startpause>Start</button>
        <button class="btn secondary" data-reset>Reset</button>
      </div>
      <p class="note">Completed focus sessions: <b data-count>0</b> — after 4, take a long break.</p>
      <div class="controls" style="justify-content:center">
        <div class="field"><label>Focus (min)</label><input type="number" data-len-focus value="25" min="1" max="120" /></div>
        <div class="field"><label>Short (min)</label><input type="number" data-len-short value="5" min="1" max="60" /></div>
        <div class="field"><label>Long (min)</label><input type="number" data-len-long value="15" min="1" max="60" /></div>
      </div>
    </div>
  `);

  const display = panel.querySelector('[data-display]');
  const startBtn = panel.querySelector('[data-startpause]');

  function lengthFor(m) {
    const input = panel.querySelector(`[data-len-${m}]`);
    return Math.max(1, Number(input.value) || MODES[m][1]) * 60;
  }
  function draw() {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    const text = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    display.textContent = text;
    document.title = timer ? `${text} · ${MODES[mode][0]} — UniLab` : 'Focus Timer — UniLab';
  }
  function stop() {
    clearInterval(timer);
    timer = null;
    startBtn.textContent = 'Start';
  }
  function switchMode(m) {
    stop();
    mode = m;
    remaining = lengthFor(m);
    panel.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    panel.querySelector('[data-modelabel]').textContent = MODES[m][0];
    draw();
  }

  panel.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));
  panel.querySelectorAll('.controls input').forEach((i) => i.addEventListener('change', () => { if (!timer) switchMode(mode); }));

  startBtn.addEventListener('click', () => {
    if (timer) { stop(); draw(); return; }
    startBtn.textContent = 'Pause';
    timer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        beep();
        if (mode === 'focus') {
          sessions++;
          panel.querySelector('[data-count]').textContent = sessions;
          switchMode(sessions % 4 === 0 ? 'long' : 'short');
        } else {
          switchMode('focus');
        }
        return;
      }
      draw();
    }, 1000);
    draw();
  });
  panel.querySelector('[data-reset]').addEventListener('click', () => switchMode(mode));

  // Stop the ticker when the user navigates away from this tool.
  window.addEventListener('hashchange', () => { stop(); document.title = 'UniLab — Every tool a student needs'; }, { once: true });

  draw();
  container.appendChild(panel);
  container.appendChild(el(`<p class="note">The tab title shows the countdown, so you can see it while writing in another tab.</p>`));
}
