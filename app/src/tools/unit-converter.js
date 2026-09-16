import { el } from '../ui.js';

// Factor-based categories convert through a base unit; temperature is special-cased.
const CATEGORIES = {
  Length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, inch: 0.0254, ft: 0.3048, yd: 0.9144, mile: 1609.344 },
  Mass: { kg: 1, g: 0.001, mg: 1e-6, lb: 0.45359237, oz: 0.028349523125, 'metric ton': 1000 },
  Temperature: null,
  Area: { 'm²': 1, 'cm²': 1e-4, 'km²': 1e6, 'rai (ไร่)': 1600, 'ngan (งาน)': 400, 'wah² (ตร.วา)': 4, acre: 4046.856, 'ft²': 0.09290304 },
  Volume: { L: 1, mL: 0.001, 'm³': 1000, 'US gallon': 3.785411784, 'US cup': 0.2365882365, 'tbsp': 0.01478676478125, 'tsp': 0.00492892159375 },
  Speed: { 'km/h': 1, 'm/s': 3.6, mph: 1.609344, knot: 1.852 },
  Data: { MB: 1, KB: 1 / 1024, GB: 1024, TB: 1024 ** 2, B: 1 / 1024 ** 2, Mbit: 1 / 8, Gbit: 128 },
  Time: { minute: 1, second: 1 / 60, hour: 60, day: 1440, week: 10080, 'class period (50 min)': 50 },
};
const TEMPS = ['°C', '°F', 'K'];

function toC(v, u) { return u === '°C' ? v : u === '°F' ? (v - 32) * 5 / 9 : v - 273.15; }
function fromC(c, u) { return u === '°C' ? c : u === '°F' ? c * 9 / 5 + 32 : c + 273.15; }

export default function render(container) {
  const panel = el(`
    <div class="panel">
      <div class="field" style="max-width:240px">
        <label>Category</label>
        <select data-cat>${Object.keys(CATEGORIES).map((c) => `<option>${c}</option>`).join('')}</select>
      </div>
      <div class="controls" style="align-items:end">
        <div class="field"><label>From</label><input type="number" data-val value="1" step="any" style="min-width:150px" /></div>
        <div class="field"><label>&nbsp;</label><select data-from></select></div>
        <button class="icon-btn" data-swap title="Swap units" style="height:40px;width:40px;font-size:16px">⇄</button>
        <div class="field"><label>To</label><select data-to></select></div>
      </div>
      <div class="big-stats" style="grid-template-columns:1fr">
        <div class="big-stat"><div class="v" data-result style="font-size:32px">—</div><div class="k" data-resultlabel>Result</div></div>
      </div>
    </div>
  `);

  const catSel = panel.querySelector('[data-cat]');
  const fromSel = panel.querySelector('[data-from]');
  const toSel = panel.querySelector('[data-to]');
  const valIn = panel.querySelector('[data-val]');

  function units() {
    return catSel.value === 'Temperature' ? TEMPS : Object.keys(CATEGORIES[catSel.value]);
  }
  function fillUnits() {
    const u = units();
    fromSel.innerHTML = u.map((x) => `<option>${x}</option>`).join('');
    toSel.innerHTML = u.map((x) => `<option>${x}</option>`).join('');
    toSel.selectedIndex = Math.min(1, u.length - 1);
    update();
  }
  function update() {
    const v = Number(valIn.value);
    const resEl = panel.querySelector('[data-result]');
    if (!Number.isFinite(v)) { resEl.textContent = '—'; return; }
    let result;
    if (catSel.value === 'Temperature') {
      result = fromC(toC(v, fromSel.value), toSel.value);
    } else {
      const table = CATEGORIES[catSel.value];
      result = (v * table[fromSel.value]) / table[toSel.value];
    }
    const rounded = Math.abs(result) >= 1e9 || (Math.abs(result) < 1e-6 && result !== 0)
      ? result.toExponential(4)
      : Number(result.toPrecision(8)).toString();
    resEl.textContent = rounded;
    panel.querySelector('[data-resultlabel]').textContent = `${valIn.value} ${fromSel.value} = ${rounded} ${toSel.value}`;
  }

  catSel.addEventListener('change', fillUnits);
  [fromSel, toSel, valIn].forEach((n) => n.addEventListener('input', update));
  panel.querySelector('[data-swap]').addEventListener('click', () => {
    const i = fromSel.selectedIndex;
    fromSel.selectedIndex = toSel.selectedIndex;
    toSel.selectedIndex = i;
    update();
  });

  fillUnits();
  container.appendChild(panel);
  container.appendChild(el(`<p class="note">Includes Thai land units (ไร่ / งาน / ตารางวา) — handy for law, business and engineering classes.</p>`));
}
