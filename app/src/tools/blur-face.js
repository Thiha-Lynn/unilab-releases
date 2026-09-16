import JSZip from 'jszip';
import { canvasToBlob, downloadBlob, el, formatBytes, loadImage, stem, toast } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, infoBox, liveExplain, optionPanel, segmented, sliderField,
} from '../option-ui.js';

// Anonymising a photo is the one job where uploading it to a website is
// self-defeating: you hand the untouched original, faces and all, to a stranger
// in order to be given back a copy with the faces hidden. So this tool is the
// clearest demonstration of what UniLab is for — the photo is opened by this
// page, redrawn by this page, and saved by this page.
//
// Two design decisions that are not obvious:
//
// * Manual boxes first, automatic detection second. Dragging a box always
//   works, in every browser, and it covers the things no face detector will
//   ever find: motorbike plate numbers, student ID cards, a name on a whiteboard,
//   a room number on a door. Automatic detection is offered only where the
//   browser already ships a detector (window.FaceDetector — Chrome, mostly on
//   Android and macOS); we do not drag in a second machine-learning model for
//   something a drag already solves.
//
// * Pixelate is the default, not blur. A Gaussian blur is a reversible filter:
//   the information is still there, spread out, and a deconvolution or a
//   brute-force "which face blurs to this?" search can pull a recognisable
//   face back out of a light blur. Averaging a face down to three or four
//   blocks throws the information away — there is nothing left to recover.

const MODES = [
  { id: 'pixelate', label: 'Pixelate' },
  { id: 'blur', label: 'Blur' },
  { id: 'box', label: 'Black box' },
];

// A browser canvas refuses to allocate past these, and Safari on a phone is the
// strictest of the lot. The export redraws the photo at its full size, so a
// sentence naming the file beats a silently blank JPG.
const MAX_SIDE = 16384;
const MAX_PIXELS = 16_777_216;

const PREVIEW_MAX = 900;    // preview pixels; the export always runs at full size
const MIN_BOX = 0.012;      // a drag smaller than this (fraction of the photo) is a mis-click
const FACE_PAD = 0.16;      // detectors return a tight box; ears, jaw and hairline give it away too

export default function render(container, tool) {
  const state = {
    index: 0,             // which photo the workarea is showing
    mode: 'pixelate',
    selected: -1,         // index into the current photo's boxes, or -1
    loadGen: 0,
  };
  const ui = {};          // sidebar controls, filled in by options()
  let dom = null;         // workarea nodes, built once
  let files = null;       // the shell's live array, captured on the first refresh
  let repaintQueued = 0;    // the pending rAF handle for a drag repaint

  // Boxes and decoded images belong to the File, not to a position in the list —
  // removing photo 2 must not shift photo 3's boxes onto photo 4.
  const boxesFor = new WeakMap();
  const imageFor = new WeakMap();

  const hasDetector = typeof window !== 'undefined' && 'FaceDetector' in window;

  toolShell(container, tool, {
    accept: 'image/*',
    multiple: true,
    minFiles: 1,
    pickLabel: 'Select photos',
    dropLabel: 'or drop them here',
    sortable: true,
    actionLabel: 'Hide the faces',
    doneTitle: 'Those faces are gone!',
    downloadLabel: 'Download the safe photo',
    continueTo: ['compress-image', 'image-text', 'watermark-image'],
    note: 'Saving through this tool also drops the photo\'s hidden EXIF data — including the GPS coordinates your phone wrote into it. A photo of a protest or a dorm room can give away where it was taken even with every face covered, so this is worth knowing about.',

    // The workarea shows the photo with the effect already applied, boxes and
    // all. You should never have to press Export to find out whether the plate
    // number is still readable.
    workarea(host, ctx) { files = ctx.files; buildWorkarea(host); },

    // The A-Z sort FAB reorders the shell's array underneath us, so the shown
    // photo has to be re-clamped and repainted on every refresh.
    onChange(ctx) {
      files = ctx.files;
      if (state.index >= files.length) state.index = Math.max(0, files.length - 1);
      // The highlight is an index into one photo's boxes; after a reorder it
      // would be pointing at a different photo's box.
      state.selected = -1;
      update();
    },

    async onFiles(ctx) {
      files = ctx.files;
      state.index = Math.min(state.index, Math.max(0, files.length - 1));
      state.selected = -1;
      await loadCurrent();
    },

    options(host) {
      const panel = optionPanel('Hide faces');

      ui.info = infoBox(
        'Drag a box over every face, plate number or ID card. Pixelate is the default on purpose: a blur can sometimes be undone, but a face averaged down to a few blocks is gone for good.',
      );

      ui.facts = fileFacts();

      ui.mode = segmented(MODES, (m) => { state.mode = m.id; syncVisibility(); update(); },
        { active: 0 });

      ui.strength = sliderField('Strength', {
        value: 6, min: 1, max: 10, step: 1, onChange: update,
      });

      ui.round = checkRow('Round corners', {
        hint: 'A rounded patch over a face looks deliberate rather than like a printing fault.',
        onChange: update,
      });

      ui.list = boxList();
      ui.explain = liveExplain();

      panel.add(ui.info, ui.facts, ui.mode, ui.strength, ui.round, ui.list, ui.explain);
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      const jobs = (files ?? []).filter((f) => (boxesFor.get(f) ?? []).length);
      if (!jobs.length) {
        throw new Error('Nothing is covered yet. Drag a box across each face or plate number in the photo first — you can draw as many as you need.');
      }

      const outputs = [];
      const naming = uniqueNames();
      for (let i = 0; i < jobs.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        const file = jobs[i];
        ctx.setBusy(i / jobs.length, `Hiding faces in photo ${i + 1} of ${jobs.length}…`);

        const img = await getImage(file);
        const canvas = drawResult(img, boxesFor.get(file) ?? [], Infinity);
        // PNG for a PNG in, JPG for everything else: re-encoding a photo as PNG
        // triples its size for no gain, and a JPG here is already a re-encode.
        const png = /png$/i.test(file.type) || /\.png$/i.test(file.name);
        const blob = await canvasToBlob(canvas, png ? 'image/png' : 'image/jpeg', png ? undefined : 0.92);
        outputs.push({ name: naming(`${stem(file.name)}-${suffix()}.${png ? 'png' : 'jpg'}`), blob });

        // Yield between photos so a batch of twenty never locks the tab up.
        await new Promise((r) => setTimeout(r, 0));
      }

      return {
        outputs,
        doneTitle: outputs.length > 1
          ? `${outputs.length} photos are safe to share.`
          : 'That photo is safe to share.',
        downloadLabel: outputs.length > 1 ? `Download ${outputs.length} photos` : 'Download the safe photo',
        zip: async () => {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.blob));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), 'photos-anonymised.zip');
        },
      };
    },
  });

  window.addEventListener('hashchange', function leave() {
    window.removeEventListener('hashchange', leave);
    if (repaintQueued) { cancelAnimationFrame(repaintQueued); repaintQueued = 0; }
    dom = null;
  });

  // ---------------------------------------------------------------------------
  // boxes

  /**
   * Two photos picked from two different folders can share a filename, and a
   * ZIP is keyed by name — the second entry would quietly replace the first and
   * the student would get fewer files than the button promised. This hands the
   * repeats a -2, -3 suffix instead.
   */
  function uniqueNames() {
    const used = new Set();
    return (name) => {
      if (!used.has(name)) { used.add(name); return name; }
      const dot = name.lastIndexOf('.');
      const base = dot < 1 ? name : name.slice(0, dot);
      const ext = dot < 1 ? '' : name.slice(dot);
      let n = 2;
      while (used.has(`${base}-${n}${ext}`)) n++;
      used.add(`${base}-${n}${ext}`);
      return `${base}-${n}${ext}`;
    };
  }

  function current() { return files?.[state.index] ?? null; }

  function boxes(file = current()) {
    if (!file) return [];
    let list = boxesFor.get(file);
    if (!list) { list = []; boxesFor.set(file, list); }
    return list;
  }

  function totalBoxes() {
    return (files ?? []).reduce((sum, f) => sum + (boxesFor.get(f)?.length ?? 0), 0);
  }

  async function getImage(file) {
    let img = imageFor.get(file);
    if (!img) {
      img = await loadImage(file);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) throw new Error(`${file.name} came back with no pixels. Try re-saving it as a JPG or PNG, then cover the faces.`);
      if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) {
        throw new Error(`${file.name} is ${w}×${h}, which is more than a browser canvas can redraw — phones especially. Shrink it with Resize Image first, then come back.`);
      }
      imageFor.set(file, img);
    }
    return img;
  }

  // ---------------------------------------------------------------------------
  // the effect — the same code path draws the preview and the exported file

  function suffix() {
    return state.mode === 'pixelate' ? 'pixelated' : state.mode === 'blur' ? 'blurred' : 'covered';
  }

  /**
   * Strength is one slider for three very different effects, so it is mapped
   * separately for each. For pixelation the honest unit is *how few blocks the
   * face is reduced to*: at strength 6 a face becomes a 4-block smear, which no
   * amount of processing can turn back into a person.
   */
  function blocksAcross() {
    return Math.min(24, Math.max(2, Math.round(24 / ui.strength.value)));
  }

  /** Blur radius as a fraction of the box, so it looks the same at any resolution. */
  function blurRadius(w, h) {
    return Math.max(1.5, (Math.min(w, h) * ui.strength.value) / 40);
  }

  /** Draws `img` no larger than `maxSide` with every box treated. Returns the canvas. */
  function drawResult(img, list, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.max(1, Math.round(img.naturalWidth * scale));
    const H = Math.max(1, Math.round(img.naturalHeight * scale));

    // The untouched copy is the source for every effect, so two overlapping
    // boxes do not blur an already-blurred patch and quietly look stronger than
    // the slider says.
    const src = document.createElement('canvas');
    src.width = W;
    src.height = H;
    src.getContext('2d').drawImage(img, 0, 0, W, H);

    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d');
    ctx.drawImage(src, 0, 0);

    for (const b of list) {
      const x = b.x * W, y = b.y * H, w = b.w * W, h = b.h * H;
      if (w < 1 || h < 1) continue;
      ctx.save();
      clipBox(ctx, x, y, w, h, ui.round.value ? Math.min(w, h) * 0.22 : 0);

      if (state.mode === 'box') {
        ctx.fillStyle = '#000000';
        ctx.fillRect(x, y, w, h);
      } else if (state.mode === 'blur') {
        const r = blurRadius(w, h);
        // Blurring a lifted rectangle would pull in transparent pixels from
        // outside it and leave a pale halo, so the patch is cut with a margin
        // of real neighbouring pixels three radii wide and blurred whole; the
        // clip above throws the margin away again.
        const pad = Math.ceil(r * 3);
        const sx = Math.max(0, Math.floor(x - pad));
        const sy = Math.max(0, Math.floor(y - pad));
        const sw = Math.min(W, Math.ceil(x + w + pad)) - sx;
        const sh = Math.min(H, Math.ceil(y + h + pad)) - sy;
        const patch = document.createElement('canvas');
        patch.width = Math.max(1, sw);
        patch.height = Math.max(1, sh);
        patch.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
        ctx.filter = `blur(${r.toFixed(2)}px)`;
        ctx.drawImage(patch, sx, sy);
        ctx.filter = 'none';
      } else {
        const across = blocksAcross();
        const bw = Math.max(1, across);
        const bh = Math.max(1, Math.round((across * h) / Math.max(1, w)));
        const tiny = document.createElement('canvas');
        tiny.width = bw;
        tiny.height = bh;
        // Scaling down averages each block; scaling back up with smoothing off
        // keeps the hard squares. There is no path back from this.
        tiny.getContext('2d').drawImage(src, x, y, w, h, 0, 0, bw, bh);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tiny, 0, 0, bw, bh, x, y, w, h);
        ctx.imageSmoothingEnabled = true;
      }
      ctx.restore();
    }
    return out;
  }

  function clipBox(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (r > 0.5 && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
    ctx.clip();
  }

  // ---------------------------------------------------------------------------
  // the sidebar list of boxes

  function boxList() {
    const root = el(`
      <div class="opt__field">
        <label class="opt__label">Boxes on this photo</label>
        <div class="opt__repeat">
          <div class="opt__repeat__list" data-list></div>
        </div>
        <p class="opt__hint" data-empty>None yet — drag one across a face on the left.</p>
      </div>
    `);
    const list = root.querySelector('[data-list]');
    const empty = root.querySelector('[data-empty]');

    function paint() {
      const items = boxes();
      list.innerHTML = '';
      empty.hidden = items.length > 0;
      items.forEach((b, i) => {
        const row = el(`
          <div class="opt__repeat__row" style="cursor:pointer">
            <div class="opt__repeat__head">
              <span class="opt__repeat__title">Box</span>
              <span class="opt__repeat__n"></span>
              <button class="opt__repeat__rm" type="button" aria-label="Remove this box">✕</button>
            </div>
          </div>
        `);
        row.querySelector('.opt__repeat__n').textContent = String(i + 1);
        if (i === state.selected) row.style.outline = '2px solid var(--accent)';
        // Naming what a box covers ("18% of the photo") is noise; where it sits
        // is what tells you which one you are about to delete.
        const where = el(`<p class="opt__hint" style="margin:2px 0 0"></p>`);
        where.textContent = b.auto ? 'Found automatically' : 'Drawn by hand';
        row.appendChild(where);
        row.addEventListener('click', (e) => {
          if (e.target.closest('.opt__repeat__rm')) return;
          state.selected = i;
          update();
        });
        row.querySelector('.opt__repeat__rm').addEventListener('click', () => {
          boxes().splice(i, 1);
          state.selected = -1;
          update();
        });
        list.appendChild(row);
      });
    }
    return { root, paint };
  }

  // ---------------------------------------------------------------------------
  // the workarea

  function buildWorkarea(host) {
    if (dom) return;   // refresh() calls workarea() again on every change

    const root = el(`
      <div>
        <div class="actions" style="margin-top:0">
          <button class="icon-btn" data-prev type="button" title="Previous photo">‹</button>
          <span class="ts__hint" style="margin:0;min-width:11em" data-label>—</span>
          <button class="icon-btn" data-next type="button" title="Next photo">›</button>
          <span style="flex:1"></span>
          <button class="btn small" data-auto type="button">Find faces automatically</button>
          <button class="btn small secondary" data-clear type="button">Clear this photo</button>
        </div>
        <div class="canvas-stage" data-stage style="min-height:220px">
          <div data-frame tabindex="0" style="position:relative;max-width:100%;line-height:0;touch-action:none;user-select:none;cursor:crosshair;outline-offset:3px">
            <p class="ts__hint" data-empty style="margin:0;padding:28px;line-height:1.5">Your photo will appear here.</p>
          </div>
        </div>
        <p class="ts__hint" data-tip></p>
      </div>
    `);

    dom = {
      root,
      label: root.querySelector('[data-label]'),
      frame: root.querySelector('[data-frame]'),
      tip: root.querySelector('[data-tip]'),
      auto: root.querySelector('[data-auto]'),
    };

    // Automatic detection is a bonus that exists only where the browser already
    // has a detector. Offering a button that always fails would be worse than
    // not offering one.
    dom.auto.hidden = !hasDetector;
    dom.auto.addEventListener('click', findFaces);

    root.querySelector('[data-prev]').addEventListener('click', () => showPhoto(state.index - 1));
    root.querySelector('[data-next]').addEventListener('click', () => showPhoto(state.index + 1));
    root.querySelector('[data-clear]').addEventListener('click', () => {
      if (!boxes().length) { toast('This photo has no boxes on it.'); return; }
      boxes().length = 0;
      state.selected = -1;
      update();
    });

    wireDrawing(dom.frame);
    host.innerHTML = '';
    host.appendChild(root);
    loadCurrent();
  }

  function showPhoto(n) {
    if (!files?.length) return;
    state.index = Math.min(files.length - 1, Math.max(0, n));
    state.selected = -1;
    loadCurrent();
  }

  async function loadCurrent() {
    const gen = ++state.loadGen;
    const file = current();
    if (!file || !dom) { update(); return; }
    dom.label.textContent = 'Opening the photo…';
    try {
      await getImage(file);
    } catch (err) {
      if (gen !== state.loadGen) return;
      // update() rewrites the label, so the reason goes in after it.
      update();
      dom.label.textContent = err.message;
      return;
    }
    if (gen !== state.loadGen) return;
    update();
  }

  // ---------------------------------------------------------------------------
  // drawing, moving and resizing boxes

  function wireDrawing(frame) {
    let drag = null;

    frame.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !current()) return;
      frame.setPointerCapture(e.pointerId);
      // Focus the frame so Delete reaches the keydown handler below; clicking a
      // box is how everyone selects one, and nobody tabs here first.
      frame.focus({ preventScroll: true });
      const p = pointAt(frame, e);
      const hit = e.target.closest?.('[data-box]');

      if (hit) {
        const i = Number(hit.dataset.box);
        state.selected = i;
        // The resize grip carries data-box too (so the hit test finds the right
        // box from it), which is why the branch tests for the attribute rather
        // than a truthy dataset value — `data-grip` with no value reads as ''.
        drag = hit.hasAttribute('data-grip')
          ? { kind: 'resize', i }
          : { kind: 'move', i, box: { ...boxes()[i] }, from: p };
      } else {
        drag = { kind: 'draw', start: p, rect: null };
        state.selected = -1;
      }
      e.preventDefault();
      update();
    });

    frame.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = pointAt(frame, e);
      if (drag.kind === 'draw') {
        drag.rect = rectBetween(drag.start, p);
        paintGhost(drag.rect);
      } else if (drag.kind === 'move') {
        const b = boxes()[drag.i];
        if (!b) return;
        b.x = clampPos(drag.box.x + (p.x - drag.from.x), b.w);
        b.y = clampPos(drag.box.y + (p.y - drag.from.y), b.h);
        queueRepaint();
      } else {
        const b = boxes()[drag.i];
        if (!b) return;
        b.w = Math.max(MIN_BOX, Math.min(1 - b.x, p.x - b.x));
        b.h = Math.max(MIN_BOX, Math.min(1 - b.y, p.y - b.y));
        queueRepaint();
      }
    });

    const finish = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      paintGhost(null);
      if (d.kind === 'draw') {
        if (!d.rect) return;                       // a plain click on the photo
        if (d.rect.w < MIN_BOX || d.rect.h < MIN_BOX) {
          toast('That box was too small to hide anything — drag a bit further.');
          return;
        }
        boxes().push({ ...d.rect });
        state.selected = boxes().length - 1;
      }
      update();
    };
    frame.addEventListener('pointerup', finish);
    frame.addEventListener('pointercancel', finish);

    // Keyboard is the only way to delete a box without hunting for its row in
    // the sidebar, and it is what everyone tries first.
    dom.root.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected >= 0) {
        e.preventDefault();
        boxes().splice(state.selected, 1);
        state.selected = -1;
        update();
      }
    });
  }

  function pointAt(frame, e) {
    const r = frame.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height))),
    };
  }

  function rectBetween(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  /** Keeps a moved box's origin inside the photo, given the box's own size. */
  function clampPos(v, size) { return Math.min(1 - size, Math.max(0, v)); }

  // A move or a resize fires on every pointer event; coalescing the repaint into
  // one frame keeps a big photo from stuttering under the finger. This is a
  // purely visual redraw, never part of the export loop.
  function queueRepaint() {
    if (repaintQueued) return;
    repaintQueued = requestAnimationFrame(() => { repaintQueued = 0; update(); });
  }

  // ---------------------------------------------------------------------------
  // automatic detection, where the browser offers it

  async function findFaces() {
    const file = current();
    if (!file) return;
    dom.auto.disabled = true;
    const label = dom.auto.textContent;
    dom.auto.textContent = 'Looking…';
    try {
      // A photo the browser cannot open at all deserves its own sentence rather
      // than the detector's, so the reason is tagged on the way past.
      const img = await getImage(file).catch((err) => { throw Object.assign(err, { fromLoad: true }); });
      const detector = new window.FaceDetector({ maxDetectedFaces: 32, fastMode: false });
      const found = await detector.detect(img);
      const W = img.naturalWidth, H = img.naturalHeight;
      let added = 0;
      for (const face of found) {
        const bb = face.boundingBox;
        // Detector boxes stop at the jaw and the hairline; a box that tight
        // leaves the ears, the hair and the chin, which is plenty to recognise
        // somebody by. Grow it.
        const padX = bb.width * FACE_PAD;
        const padY = bb.height * FACE_PAD;
        const rect = {
          x: Math.max(0, (bb.x - padX) / W),
          y: Math.max(0, (bb.y - padY) / H),
          w: Math.min(1, (bb.width + padX * 2) / W),
          h: Math.min(1, (bb.height + padY * 2) / H),
          auto: true,
        };
        rect.w = Math.min(rect.w, 1 - rect.x);
        rect.h = Math.min(rect.h, 1 - rect.y);
        if (rect.w < MIN_BOX || rect.h < MIN_BOX) continue;
        boxes().push(rect);
        added++;
      }
      toast(added
        ? `Found ${added} face${added === 1 ? '' : 's'} — check them and drag any it missed.`
        : 'No faces found in this one. Draw the boxes by hand.');
      update();
    } catch (err) {
      toast(err?.fromLoad
        ? err.message
        : 'This browser has a face detector but it would not run. Draw the boxes by hand — that always works.');
    } finally {
      dom.auto.disabled = false;
      dom.auto.textContent = label;
    }
  }

  // ---------------------------------------------------------------------------
  // painting

  function paintPreview() {
    if (!dom) return;
    const file = current();
    const img = file ? imageFor.get(file) : null;

    if (!img) {
      dom.frame.innerHTML = '<p class="ts__hint" data-empty style="margin:0;padding:28px;line-height:1.5">Your photo will appear here.</p>';
      return;
    }

    const canvas = drawResult(img, boxes(), PREVIEW_MAX);
    Object.assign(canvas.style, { display: 'block', maxWidth: '100%', height: 'auto' });
    dom.frame.innerHTML = '';
    dom.frame.appendChild(canvas);

    boxes().forEach((b, i) => {
      const node = el(`<div data-box tabindex="0"><span data-grip></span></div>`);
      node.dataset.box = String(i);
      const on = i === state.selected;
      Object.assign(node.style, {
        position: 'absolute',
        left: `${b.x * 100}%`,
        top: `${b.y * 100}%`,
        width: `${b.w * 100}%`,
        height: `${b.h * 100}%`,
        border: `2px ${b.auto ? 'dashed' : 'solid'} ${on ? 'var(--accent)' : 'rgba(255,255,255,.85)'}`,
        borderRadius: ui.round.value ? '10px' : '2px',
        boxShadow: on ? '0 0 0 2px rgba(91,91,214,.35)' : '0 0 0 1px rgba(23,28,38,.45)',
        cursor: 'move',
        boxSizing: 'border-box',
      });
      const grip = node.querySelector('[data-grip]');
      grip.dataset.box = String(i);
      Object.assign(grip.style, {
        position: 'absolute', right: '-7px', bottom: '-7px',
        width: '14px', height: '14px', borderRadius: '3px',
        background: 'var(--accent)', border: '2px solid #fff',
        cursor: 'nwse-resize',
      });
      dom.frame.appendChild(node);
    });
  }

  function paintGhost(rect) {
    if (!dom) return;
    dom.frame.querySelector('[data-ghost]')?.remove();
    if (!rect) return;
    const node = el(`<div data-ghost></div>`);
    Object.assign(node.style, {
      position: 'absolute',
      left: `${rect.x * 100}%`,
      top: `${rect.y * 100}%`,
      width: `${rect.w * 100}%`,
      height: `${rect.h * 100}%`,
      background: 'rgba(91,91,214,.30)',
      outline: '2px dashed var(--accent)',
      pointerEvents: 'none',
    });
    dom.frame.appendChild(node);
  }

  // ---------------------------------------------------------------------------

  function syncVisibility() {
    // A black box has no strength — it is opaque. Leaving a dead slider on
    // screen invites people to drag it and wonder why nothing happens.
    ui.strength.root.hidden = state.mode === 'box';
  }

  function update() {
    if (!ui.explain) return;
    const file = current();
    const list = boxes();
    const total = totalBoxes();
    const photos = files?.length ?? 0;

    ui.facts.set(file
      ? [
        ['Photo', `${state.index + 1} of ${photos}`],
        ['Size', formatBytes(file.size)],
        ['Boxes in total', String(total)],
      ]
      : []);

    if (dom) {
      dom.label.textContent = file ? `${state.index + 1} / ${photos} · ${file.name}` : '—';
      dom.tip.textContent = list.length
        ? 'Drag a box to move it, drag its corner to resize, press Delete to remove it. Draw as many as you need.'
        : 'Drag across a face, a plate number or an ID card. Anything you cover here is redrawn — it is not a sticker over the top.';
      dom.auto.hidden = !hasDetector || !file;
    }

    ui.list.paint();

    const covered = state.mode === 'pixelate'
      ? `pixelated down to about ${blocksAcross()} blocks across`
      : state.mode === 'blur'
        ? `blurred hard enough that the shapes go`
        : 'covered with a solid black box';

    const skipped = photos - (files ?? []).filter((f) => (boxesFor.get(f) ?? []).length).length;

    ui.explain.set(
      !photos
        ? ''
        : !total
          ? 'Nothing is covered yet. Drag a box across each face or plate number.'
          : `${total} box${total === 1 ? '' : 'es'} will be ${covered}.`
            + (skipped ? ` ${skipped} photo${skipped === 1 ? '' : 's'} still ${skipped === 1 ? 'has' : 'have'} no boxes and will be skipped.` : '')
            + (state.mode === 'blur' ? ' A blur can sometimes be undone — pixelate is safer.' : ''),
    );

    paintPreview();
  }
}
