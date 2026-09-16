import JSZip from 'jszip';
import { canvasToBlob, downloadBlob, el, loadImage, stem, MIME_EXT } from '../ui.js';
import { toolShell } from '../tool-shell.js';
import {
  checkRow, fileFacts, liveExplain, optionPanel, segmented, selectField, sliderField,
} from '../option-ui.js';

// The bulk turn. "None" is first and is the default on purpose: a folder from a
// phone is usually mostly fine, and the common job is "leave everything alone
// except these three", which the per-card rotate buttons already do. Forcing a
// quarter-turn on the whole batch just to reach that state would be wrong.
const TURNS = [
  { id: 'none', label: 'None' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'flip', label: '180°' },
];
const TURN_DEGREES = { none: 0, left: -90, right: 90, flip: 180 };

const FORMATS = [
  { id: 'keep', label: 'Keep the original format' },
  { id: 'image/jpeg', label: 'JPG — smallest for photos' },
  { id: 'image/png', label: 'PNG — no quality loss' },
  { id: 'image/webp', label: 'WebP — smaller again' },
];

// A browser canvas refuses to allocate past these, and Safari on a phone is the
// strictest of the lot. A silently blank export is a far worse outcome than a
// sentence telling the student to shrink the photo first.
const MAX_SIDE = 16384;
const MAX_PIXELS = 16_777_216;

const normalize = (deg) => ((deg % 360) + 360) % 360;
const isNoop = (deg) => { const n = normalize(deg); return n < 1e-6 || n > 360 - 1e-6; };

export default function render(container, tool) {
  // Natural pixel sizes, keyed by the File object itself, so the landscape /
  // portrait filters and the fact box never have to decode a photo twice.
  const dims = new Map();
  const state = { files: [] };
  const ui = {};

  toolShell(container, tool, {
    accept: 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp',
    multiple: true,
    sortable: true,
    // The shell puts a rotate button on every card and tracks file.__rotation
    // for us — that is the "and while I'm here, this one too" case.
    rotatable: true,
    pickLabel: 'Select images',
    dropLabel: 'or drop a whole folder of photos here',
    actionLabel: 'Rotate images',
    doneTitle: 'Your photos are the right way up!',
    downloadLabel: 'Download rotated image',
    continueTo: ['crop-image', 'compress-image', 'image-to-pdf'],
    note: 'A photo of the whiteboard that came out sideways is still sideways after you send it — LINE and Gmail show it exactly as it is stored. Turn it here first and it stays turned everywhere. The straighten slider is for the other kind of wrong: a page you photographed at a slight angle, where two or three degrees is all it takes.',

    async onFiles(ctx) {
      state.files = ctx.files;
      // Drop measurements for files that have been removed, so a long session
      // of adding and removing photos does not hold onto stale entries.
      for (const key of [...dims.keys()]) if (!ctx.files.includes(key)) dims.delete(key);

      for (const file of ctx.files) {
        if (dims.has(file)) continue;
        try {
          const img = await loadImage(file);
          dims.set(file, { w: img.naturalWidth, h: img.naturalHeight });
        } catch {
          // A file the browser cannot decode still gets a row; run() is where
          // it fails, with a message that names it.
          dims.set(file, null);
        }
        // Measuring twenty phone photos is real work — yield so the page keeps
        // responding while the fact box fills in.
        update();
        await new Promise((r) => setTimeout(r, 0));
      }
      update();
      // The shell paints its thumbnails asynchronously, so the pass above often
      // runs before there is a picture to turn. One late repaint settles it.
      setTimeout(paintCards, 400);
    },

    onChange() { update(); },

    options(host) {
      const panel = optionPanel('Rotate');
      ui.facts = fileFacts();
      ui.explain = liveExplain();

      ui.turn = segmented(TURNS, () => update(), { active: 0 });
      // segmented() has no label slot of its own, so it sits in the same field
      // wrapper every other control uses.
      const turnField = el(`<div class="opt__field"><label class="opt__label">Turn every photo</label></div>`);
      turnField.appendChild(ui.turn.root);

      // Mixed folders are the norm — the shots from the lecture are landscape,
      // the shots of the worksheet are portrait, and only one set is wrong.
      ui.onlyLandscape = checkRow('Only rotate landscape photos', {
        onChange: (on) => { if (on) ui.onlyPortrait.value = false; update(); },
      });
      ui.onlyPortrait = checkRow('Only rotate portrait photos', {
        hint: 'Leave both off to turn everything. These only limit the quarter-turn above — a turn you set on a single card always applies.',
        onChange: (on) => { if (on) ui.onlyLandscape.value = false; update(); },
      });

      ui.straighten = sliderField('Straighten', {
        value: 0, min: -15, max: 15, step: 0.5, suffix: '°', onChange: update,
      });
      // sliderField has no hint slot, so the note goes inside its own field
      // wrapper rather than becoming a detached paragraph in the panel body.
      ui.straighten.root.appendChild(el(`<p class="opt__hint">For a page photographed at a slight angle. The canvas grows to fit the tilted photo, so no corner is cut off.</p>`));

      ui.format = selectField('Save as', FORMATS, { value: 'keep', onChange: () => { syncVisibility(); update(); } });
      ui.quality = sliderField('Quality', {
        value: 92, min: 50, max: 100, suffix: '%', onChange: update,
      });

      panel.add(
        turnField, ui.facts, ui.onlyLandscape, ui.onlyPortrait,
        ui.straighten, ui.format, ui.quality, ui.explain,
      );
      host.appendChild(panel.root);
      syncVisibility();
      update();
      return {};
    },

    async run(ctx) {
      const files = ctx.files;
      if (!files.length) throw new Error('Add at least one photo first.');

      const outputs = [];
      const naming = uniqueNames();
      let turned = 0;
      for (let i = 0; i < files.length; i++) {
        if (ctx.signal?.aborted) throw new Error('canceled');
        const file = files[i];
        ctx.setBusy(i / files.length, `Turning ${file.name} — ${i + 1} of ${files.length}…`);
        const result = await rotateOne(file);
        if (result.turned) turned++;
        outputs.push({ name: naming(result.name), blob: result.blob });
        // Yield between photos: a 12 MP decode plus re-encode is long enough
        // that the cancel button has to stay clickable.
        await new Promise((r) => setTimeout(r, 0));
      }

      return {
        outputs,
        doneTitle: turned === 0
          ? 'Saved — nothing needed turning'
          : turned === outputs.length
            ? `All ${turned} photo${turned === 1 ? '' : 's'} turned the right way up!`
            : `${turned} of ${outputs.length} photos turned the right way up!`,
        zip: async () => {
          const zip = new JSZip();
          outputs.forEach((o) => zip.file(o.name, o.blob));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), 'unilab-rotated.zip');
        },
      };
    },
  });

  // -------------------------------------------------------------------------

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

  function syncVisibility() {
    // PNG is lossless, so a quality slider beside it would be a lie. "Keep the
    // original format" can still land on JPG or WebP, so it keeps the slider.
    ui.quality.root.hidden = ui.format.value === 'image/png';
  }

  /** Does the bulk quarter-turn apply to this photo, given the two filters? */
  function bulkApplies(file) {
    const only = ui.onlyLandscape?.value ? 'landscape' : ui.onlyPortrait?.value ? 'portrait' : null;
    if (!only) return true;
    const d = dims.get(file);
    if (!d) return true;              // not measured yet — assume yes, and say so
    return orientationOf(d) === only;
  }

  function orientationOf(d) {
    return d.w > d.h ? 'landscape' : d.h > d.w ? 'portrait' : 'square';
  }

  /** Total clockwise degrees for one photo: the batch turn + its own + the tilt. */
  function totalFor(file) {
    const bulk = bulkApplies(file) ? TURN_DEGREES[ui.turn?.value ?? 'none'] : 0;
    return bulk + (file.__rotation ?? 0) + (ui.straighten?.value ?? 0);
  }

  function outputType(file) {
    const chosen = ui.format.value;
    if (chosen !== 'keep') return chosen;
    // A format canvas cannot write back out (BMP, an odd TIFF) becomes PNG
    // rather than silently becoming a JPG the student did not ask for.
    return MIME_EXT[file.type] ? file.type : 'image/png';
  }

  async function rotateOne(file) {
    const deg = totalFor(file);
    const type = outputType(file);

    // Nothing to do and nothing to convert: hand back the original bytes.
    // Re-encoding an untouched JPG would cost quality for no reason at all.
    if (isNoop(deg) && ui.format.value === 'keep') {
      return { name: file.name, blob: file, turned: false };
    }

    const img = await loadImage(file);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error(`${file.name} came back with no pixels. Try re-saving it as a JPG or PNG, then rotate it.`);
    if (w * h > MAX_PIXELS || w > MAX_SIDE || h > MAX_SIDE) {
      throw new Error(`${file.name} is ${w}×${h}, which is bigger than a browser canvas can hold — phones especially. Shrink it with Resize Image first, then come back.`);
    }

    const rad = (deg * Math.PI) / 180;
    let outW;
    let outH;
    if (Number.isInteger(deg) && deg % 90 === 0) {
      // Exact quarter turns must swap the sides exactly. Going through cos/sin
      // here would round 3024 to 3023 on some photos.
      const swap = normalize(deg) % 180 !== 0;
      outW = swap ? h : w;
      outH = swap ? w : h;
    } else {
      // A tilted photo needs a bigger canvas than it started with, or the
      // corners get cut off — which is exactly what the student was trying to
      // fix. This is the bounding box of the rotated rectangle.
      const c = Math.abs(Math.cos(rad));
      const s = Math.abs(Math.sin(rad));
      outW = Math.round(w * c + h * s);
      outH = Math.round(w * s + h * c);
    }
    if (outW * outH > MAX_PIXELS || outW > MAX_SIDE || outH > MAX_SIDE) {
      throw new Error(`Straightening ${file.name} would need a ${outW}×${outH} canvas, which is more than this browser allows. Use a smaller angle, or shrink the photo with Resize Image first.`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const c2 = canvas.getContext('2d');
    // A tilt leaves empty triangles in the corners. JPG has no transparency, so
    // those would come out black — white is what a scanned page wants.
    if (type === 'image/jpeg') {
      c2.fillStyle = '#ffffff';
      c2.fillRect(0, 0, outW, outH);
    }
    c2.imageSmoothingQuality = 'high';
    c2.translate(outW / 2, outH / 2);
    c2.rotate(rad);
    c2.drawImage(img, -w / 2, -h / 2);

    const blob = await canvasToBlob(canvas, type, type === 'image/png' ? undefined : ui.quality.value / 100);
    // Zeroing the canvas hands ~48 MB of RGBA back now instead of at the next
    // GC, which matters when the next photo in the batch is the same size.
    canvas.width = 0;
    canvas.height = 0;

    const turned = !isNoop(deg);
    const suffix = turned ? 'rotated' : 'converted';
    return { name: `${stem(file.name)}-${suffix}.${MIME_EXT[type]}`, blob, turned };
  }

  // ---- the live picture --------------------------------------------------

  function update() {
    if (!ui.explain) return;
    paintFacts();
    paintCards();

    const files = state.files;
    if (!files.length) { ui.explain.set(''); return; }

    const changed = files.filter((f) => !isNoop(totalFor(f))).length;
    const tilt = ui.straighten.value;
    const turn = ui.turn.value;
    const scope = ui.onlyLandscape.value ? 'landscape photos' : ui.onlyPortrait.value ? 'portrait photos' : null;

    const parts = [];
    if (turn !== 'none') {
      const how = turn === 'flip' ? 'turned upside down (180°)'
        : turn === 'left' ? 'turned a quarter-turn left'
          : 'turned a quarter-turn right';
      parts.push(scope ? `${how} — ${scope} only` : how);
    }
    if (tilt) parts.push(`straightened by ${tilt > 0 ? '' : '−'}${Math.abs(tilt)}° ${tilt > 0 ? 'clockwise' : 'anticlockwise'}`);

    const n = files.length;
    const noun = `${n} photo${n === 1 ? '' : 's'}`;
    const format = ui.format.value === 'keep' ? 'their own format' : FORMATS.find((f) => f.id === ui.format.value).label.split(' — ')[0];

    if (!parts.length && !changed) {
      ui.explain.set(`Nothing is turned yet. Pick a direction above, drag the straighten slider, or press the ↻ button on a single card. ${noun} would be saved as ${format}.`);
      return;
    }
    const head = parts.length ? `${parts.join(', and ')}.` : 'Only the photos you turned by hand will change.';
    ui.explain.set(`${head} ${changed} of ${noun} will come out different, saved as ${format}.`);
  }

  function paintFacts() {
    const files = state.files;
    if (!ui.facts) return;
    if (!files.length) { ui.facts.set([]); return; }
    const counts = { landscape: 0, portrait: 0, square: 0, pending: 0, bad: 0 };
    for (const f of files) {
      const d = dims.get(f);
      // No entry at all means the measuring pass has not reached it yet; an
      // entry of null means the browser tried and could not read the file.
      // Those are different things, and reporting the second as the first
      // leaves a student waiting for something that will never finish.
      if (d) counts[orientationOf(d)]++;
      else if (dims.has(f)) counts.bad++;
      else counts.pending++;
    }
    const rows = [['Photos', String(files.length)]];
    if (counts.landscape) rows.push(['Landscape', String(counts.landscape)]);
    if (counts.portrait) rows.push(['Portrait', String(counts.portrait)]);
    if (counts.square) rows.push(['Square', String(counts.square)]);
    if (counts.pending) rows.push(['Still reading', String(counts.pending)]);
    if (counts.bad) rows.push(['Could not open', String(counts.bad)]);
    ui.facts.set(rows);
  }

  /**
   * The workarea for this tool is the shell's own file cards, so the preview is
   * simply the real rotation written onto each thumbnail — the batch turn, that
   * card's own turns, and the tilt, all combined. The shell writes the per-card
   * turn onto the thumbnail box itself and then calls refresh(), so this runs
   * immediately afterwards and replaces it with the full figure.
   */
  function paintCards() {
    const host = container.querySelector('.ts__cards');
    if (!host) return;
    [...host.children].forEach((card, i) => {
      const file = state.files[i];
      const thumb = card?.querySelector?.('.ts__card__thumb');
      if (!file || !thumb) return;
      const deg = totalFor(file);
      const media = thumb.querySelector('img, canvas');
      if (!media) {
        // The thumbnail is still decoding; turn the whole box for now, and the
        // next refresh will move the transform onto the picture itself.
        thumb.style.transform = `rotate(${deg}deg)`;
        return;
      }
      // Turning the picture rather than the box means the box keeps clipping,
      // so a turned photo can never spill over the card next to it.
      thumb.style.transform = 'none';
      media.style.transformOrigin = 'center';
      media.style.transition = 'transform .18s ease';
      media.style.transform = `rotate(${deg}deg) scale(${fitScale(thumb, media, deg)})`;
    });
  }

  /**
   * A portrait thumbnail turned on its side is wider than the 108 px slot it
   * lives in, and the slot clips. Shrinking it by exactly the overflow keeps the
   * whole photo visible, which is the entire point of looking at it.
   */
  function fitScale(thumb, media, deg) {
    const boxW = thumb.clientWidth;
    const boxH = thumb.clientHeight;
    // Layout sizes, so they are the sizes *before* any transform we applied.
    const dw = media.clientWidth;
    const dh = media.clientHeight;
    if (!boxW || !boxH || !dw || !dh) return 1;
    const rad = (deg * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const s = Math.abs(Math.sin(rad));
    return Math.min(1, boxW / (dw * c + dh * s), boxH / (dw * s + dh * c));
  }
}
