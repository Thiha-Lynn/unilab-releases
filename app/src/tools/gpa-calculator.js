import { el } from '../ui.js';

// Standard Thai university scale (MFU): A=4.0 … F=0
const GRADES = { A: 4.0, 'B+': 3.5, B: 3.0, 'C+': 2.5, C: 2.0, 'D+': 1.5, D: 1.0, F: 0 };
const STORE_KEY = 'unilab-gpa-rows';

export default function render(container) {
  let rows;
  try { rows = JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { rows = null; }
  if (!Array.isArray(rows) || !rows.length) {
    rows = [{ name: '', credits: 3, grade: 'A' }, { name: '', credits: 3, grade: 'B+' }, { name: '', credits: 3, grade: 'B' }];
  }

  const panel = el(`
    <div class="panel">
      <table class="clean">
        <thead><tr><th style="width:50%">Course (optional)</th><th>Credits</th><th>Grade</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="actions">
        <button class="btn secondary small" data-add>＋ Add course</button>
        <button class="btn secondary small" data-clear>Clear all</button>
      </div>
      <div class="big-stats">
        <div class="big-stat"><div class="v" data-gpa>—</div><div class="k">Term GPA</div></div>
        <div class="big-stat"><div class="v" data-credits>0</div><div class="k">Credits</div></div>
        <div class="big-stat"><div class="v" data-points>0</div><div class="k">Grade points</div></div>
      </div>
    </div>
  `);
  const tbody = panel.querySelector('tbody');

  const cumulative = el(`
    <div class="panel">
      <h3 style="margin:0 0 4px;font-size:16px">Cumulative GPA (optional)</h3>
      <p class="note" style="margin-top:0">Enter your GPA and credits from previous terms to see your new cumulative GPA.</p>
      <div class="controls">
        <div class="field"><label>Previous GPA</label><input type="number" data-prev-gpa step="0.01" min="0" max="4" placeholder="e.g. 3.25" /></div>
        <div class="field"><label>Previous credits</label><input type="number" data-prev-credits min="0" placeholder="e.g. 96" /></div>
        <div class="big-stat" style="min-width:150px"><div class="v" data-cum>—</div><div class="k">New cumulative</div></div>
      </div>
    </div>
  `);

  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(rows)); }

  function renderRows() {
    tbody.innerHTML = '';
    rows.forEach((r, i) => {
      const tr = el(`
        <tr>
          <td><input type="text" placeholder="e.g. Software Engineering" style="width:100%;border:1.5px solid var(--line);background:var(--bg);border-radius:8px;padding:7px 10px" /></td>
          <td><input type="number" min="0" max="12" style="width:70px;border:1.5px solid var(--line);background:var(--bg);border-radius:8px;padding:7px 10px" /></td>
          <td><select style="border:1.5px solid var(--line);background:var(--bg);border-radius:8px;padding:7px 10px">${Object.keys(GRADES).map((g) => `<option>${g}</option>`).join('')}</select></td>
          <td><button class="icon-btn danger" title="Remove">✕</button></td>
        </tr>
      `);
      const [nameIn, credIn] = tr.querySelectorAll('input');
      const gradeSel = tr.querySelector('select');
      nameIn.value = r.name;
      credIn.value = r.credits;
      gradeSel.value = r.grade;
      nameIn.addEventListener('input', () => { r.name = nameIn.value; save(); });
      credIn.addEventListener('input', () => { r.credits = Number(credIn.value) || 0; update(); });
      gradeSel.addEventListener('change', () => { r.grade = gradeSel.value; update(); });
      tr.querySelector('button').addEventListener('click', () => { rows.splice(i, 1); renderRows(); update(); });
      tbody.appendChild(tr);
    });
  }

  function update() {
    save();
    const credits = rows.reduce((s, r) => s + (r.credits || 0), 0);
    const points = rows.reduce((s, r) => s + (r.credits || 0) * GRADES[r.grade], 0);
    const gpa = credits ? points / credits : null;
    panel.querySelector('[data-gpa]').textContent = gpa === null ? '—' : gpa.toFixed(2);
    panel.querySelector('[data-credits]').textContent = credits;
    panel.querySelector('[data-points]').textContent = points.toFixed(1);

    const pg = Number(cumulative.querySelector('[data-prev-gpa]').value);
    const pc = Number(cumulative.querySelector('[data-prev-credits]').value);
    const cumEl = cumulative.querySelector('[data-cum]');
    if (pg > 0 && pc > 0 && credits) {
      cumEl.textContent = ((pg * pc + points) / (pc + credits)).toFixed(2);
    } else {
      cumEl.textContent = '—';
    }
  }

  panel.querySelector('[data-add]').addEventListener('click', () => {
    rows.push({ name: '', credits: 3, grade: 'A' });
    renderRows();
    update();
  });
  panel.querySelector('[data-clear]').addEventListener('click', () => {
    rows = [{ name: '', credits: 3, grade: 'A' }];
    renderRows();
    update();
  });
  cumulative.querySelectorAll('input').forEach((i) => i.addEventListener('input', update));

  renderRows();
  container.append(panel, cumulative);
  update();
  container.appendChild(el(`<p class="note">Scale: A 4.0 · B+ 3.5 · B 3.0 · C+ 2.5 · C 2.0 · D+ 1.5 · D 1.0 · F 0. Your courses are saved on this device only.</p>`));
}
