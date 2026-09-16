import { el, toast } from '../ui.js';

// Author input: "Last, First; Last, First" (or organization name without comma).
function parseAuthors(raw) {
  return raw.split(';').map((a) => a.trim()).filter(Boolean).map((a) => {
    const [last, first] = a.split(',').map((s) => s.trim());
    return first ? { last, first } : { org: a };
  });
}

function apaAuthors(authors) {
  const one = (a) => (a.org ? a.org : `${a.last}, ${a.first.split(/\s+/).map((n) => n[0].toUpperCase() + '.').join(' ')}`);
  if (!authors.length) return '';
  if (authors.length === 1) return one(authors[0]);
  if (authors.length === 2) return `${one(authors[0])}, & ${one(authors[1])}`;
  return authors.slice(0, -1).map(one).join(', ') + ', & ' + one(authors[authors.length - 1]);
}

function mlaAuthors(authors) {
  const first = (a) => (a.org ? a.org : `${a.last}, ${a.first}`);
  const rest = (a) => (a.org ? a.org : `${a.first} ${a.last}`);
  if (!authors.length) return '';
  if (authors.length === 1) return first(authors[0]);
  if (authors.length === 2) return `${first(authors[0])}, and ${rest(authors[1])}`;
  return `${first(authors[0])}, et al.`;
}

const FIELDS = {
  website: [
    ['authors', 'Author(s) — Last, First; Last, First (or organization)', 'text'],
    ['year', 'Year (blank = n.d.)', 'text'],
    ['title', 'Page title *', 'text'],
    ['site', 'Website name *', 'text'],
    ['url', 'URL *', 'url'],
  ],
  book: [
    ['authors', 'Author(s) — Last, First; Last, First', 'text'],
    ['year', 'Year *', 'text'],
    ['title', 'Book title *', 'text'],
    ['publisher', 'Publisher *', 'text'],
  ],
  journal: [
    ['authors', 'Author(s) — Last, First; Last, First', 'text'],
    ['year', 'Year *', 'text'],
    ['title', 'Article title *', 'text'],
    ['journal', 'Journal name *', 'text'],
    ['volume', 'Volume', 'text'],
    ['issue', 'Issue', 'text'],
    ['pages', 'Pages (e.g. 12-34)', 'text'],
    ['doi', 'DOI or URL', 'text'],
  ],
};

function buildCitation(type, style, v) {
  const authors = parseAuthors(v.authors || '');
  const A = style === 'apa' ? apaAuthors(authors) : mlaAuthors(authors);
  const yr = v.year?.trim();
  if (style === 'apa') {
    if (type === 'website') {
      return `${A ? A + ' ' : ''}(${yr || 'n.d.'}). ${v.title}. <i>${v.site}</i>. ${v.url}`;
    }
    if (type === 'book') {
      return `${A} (${yr}). <i>${v.title}</i>. ${v.publisher}.`;
    }
    const vol = v.volume ? `<i>${v.volume}</i>` : '';
    const iss = v.issue ? `(${v.issue})` : '';
    const pg = v.pages ? `, ${v.pages}` : '';
    return `${A} (${yr}). ${v.title}. <i>${v.journal}</i>${vol || iss ? `, ${vol}${iss}` : ''}${pg}.${v.doi ? ' ' + v.doi : ''}`;
  }
  // MLA 9
  if (type === 'website') {
    return `${A ? A + '. ' : ''}“${v.title}.” <i>${v.site}</i>${yr ? `, ${yr}` : ''}, ${v.url}.`;
  }
  if (type === 'book') {
    return `${A}. <i>${v.title}</i>. ${v.publisher}, ${yr}.`;
  }
  const vol = v.volume ? `vol. ${v.volume}, ` : '';
  const iss = v.issue ? `no. ${v.issue}, ` : '';
  const pg = v.pages ? `pp. ${v.pages}` : '';
  return `${A}. “${v.title}.” <i>${v.journal}</i>, ${vol}${iss}${yr}, ${pg}${v.doi ? `, ${v.doi}` : ''}.`.replace(/, \./g, '.');
}

export default function render(container) {
  const saved = [];
  const panel = el(`
    <div class="panel">
      <div class="controls" style="align-items:start">
        <div class="field">
          <label>Style</label>
          <select data-style>
            <option value="apa">APA 7</option>
            <option value="mla">MLA 9</option>
          </select>
        </div>
        <div class="field">
          <label>Source type</label>
          <select data-type>
            <option value="website">Website</option>
            <option value="book">Book</option>
            <option value="journal">Journal article</option>
          </select>
        </div>
      </div>
      <div class="controls" data-fields style="align-items:start"></div>
      <div class="actions"><button class="btn" data-go>Generate citation</button></div>
      <div data-out></div>
      <div data-list></div>
    </div>
  `);
  const typeSel = panel.querySelector('[data-type]');
  const styleSel = panel.querySelector('[data-style]');
  const fieldsHost = panel.querySelector('[data-fields]');
  const out = panel.querySelector('[data-out]');
  const listHost = panel.querySelector('[data-list]');

  function renderFields() {
    fieldsHost.innerHTML = '';
    for (const [key, label, kind] of FIELDS[typeSel.value]) {
      const f = el(`
        <div class="field" style="flex:1;min-width:230px">
          <label>${label}</label>
          <input type="${kind}" data-key="${key}" />
        </div>
      `);
      fieldsHost.appendChild(f);
    }
  }
  typeSel.addEventListener('change', renderFields);
  renderFields();

  panel.querySelector('[data-go]').addEventListener('click', () => {
    const values = {};
    fieldsHost.querySelectorAll('input').forEach((i) => (values[i.dataset.key] = i.value.trim()));
    const required = FIELDS[typeSel.value].filter(([, label]) => label.includes('*')).map(([k]) => k);
    const missing = required.filter((k) => !values[k]);
    if (missing.length) { toast('Please fill the fields marked *'); return; }

    const html = buildCitation(typeSel.value, styleSel.value, values);
    out.innerHTML = '';
    const box = el(`
      <div class="citation-out">
        <div class="hanging">${html}</div>
        <div class="actions" style="margin-top:12px">
          <button class="btn small" data-copy>📋 Copy</button>
          <button class="btn secondary small" data-save>＋ Add to list</button>
        </div>
      </div>
    `);
    const plain = () => box.querySelector('.hanging').textContent;
    box.querySelector('[data-copy]').addEventListener('click', async () => {
      await navigator.clipboard.writeText(plain());
      toast('Citation copied');
    });
    box.querySelector('[data-save]').addEventListener('click', () => {
      saved.push(html);
      renderList();
      toast('Added to reference list');
    });
    out.appendChild(box);
  });

  function renderList() {
    listHost.innerHTML = '';
    if (!saved.length) return;
    const wrap = el(`
      <div style="margin-top:22px">
        <h3 style="margin:0 0 8px;font-size:16px">Reference list (${saved.length})</h3>
        <div class="citation-out" data-items></div>
        <div class="actions"><button class="btn small" data-copyall>📋 Copy all</button></div>
      </div>
    `);
    const items = wrap.querySelector('[data-items]');
    [...saved].sort((a, b) => a.localeCompare(b)).forEach((h) => items.appendChild(el(`<div class="hanging" style="margin-bottom:8px">${h}</div>`)));
    wrap.querySelector('[data-copyall]').addEventListener('click', async () => {
      await navigator.clipboard.writeText([...items.querySelectorAll('.hanging')].map((d) => d.textContent).join('\n'));
      toast('Reference list copied');
    });
    listHost.appendChild(wrap);
  }

  container.appendChild(panel);
  container.appendChild(el(`<p class="note">Copy the result into your reference list, keep the hanging indent, and always double-check against your faculty’s style guide.</p>`));
}
