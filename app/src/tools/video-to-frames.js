import JSZip from 'jszip';
import { el, dropzone, downloadBlob, canvasToBlob, errorBox, formatBytes, stem, toast, MIME_EXT } from '../ui.js';
import {
  VIDEO_ACCEPT, formatDuration, grabFrames, isCanceled, parseTimecode,
  probeMedia, requireWebCodecs, yieldToBrowser,
} from '../media-utils.js';
import { jobProgress, mediaPreview, mediaStats, resultCard } from '../media-ui.js';

// A hard ceiling on how many photos one run may produce. Past a few hundred the
// page is holding a few hundred image blobs plus their thumbnails, and a phone
// runs out of memory long before the student runs out of patience.
const MAX_FRAMES = 300;

// Thumbnails are drawn into our own small canvas: the canvas grabFrames yields
// comes from a pool and is overwritten a frame or two later, so keeping the
// reference would leave the whole grid showing the same picture.
const THUMB_WIDTH = 240;

// Past this many, one download button per photo fills the screen, so the result
// card gets a single ZIP instead and the grid handles one-off saves.
const BUTTONS_MAX = 12;

export default function render(container) {
  if (!requireWebCodecs(container)) return;

  const panel = el(`<div class="panel"></div>`);
  const resultsHost = el(`<div></div>`);
  const grid = el(`<div class="frame-grid" hidden></div>`);
  let file = null;
  let probe = null;
  let preview = null;

  const zone = dropzone({
    accept: VIDEO_ACCEPT,
    multiple: false,
    label: 'Choose a video',
    hint: 'MP4, MOV, WebM or MKV — a lecture recording is fine',
    onFiles: ([f]) => load(f),
  });

  const info = el(`<div hidden></div>`);

  const controls = el(`
    <div hidden>
      <div class="controls">
        <div class="field">
          <label>Take</label>
          <select data-mode>
            <option value="interval">A photo every few seconds</option>
            <option value="count">A fixed number of evenly spaced photos</option>
            <option value="one">Just one photo, at the time I choose</option>
          </select>
        </div>
        <div class="field" data-intervalwrap>
          <label>One photo every</label>
          <select data-interval>
            <option value="0.5">Half a second</option>
            <option value="1" selected>1 second</option>
            <option value="2">2 seconds</option>
            <option value="5">5 seconds</option>
            <option value="10">10 seconds</option>
          </select>
        </div>
        <div class="field" data-countwrap hidden>
          <label>How many</label>
          <select data-count>
            <option value="6">6 photos</option>
            <option value="12" selected>12 photos</option>
            <option value="24">24 photos</option>
            <option value="48">48 photos</option>
          </select>
        </div>
        <div class="field" data-onewrap hidden>
          <label>At this time</label>
          <input type="text" data-time inputmode="decimal" placeholder="1:15" />
          <button class="btn secondary small" type="button" data-here>Use the playback position</button>
        </div>
        <div class="field">
          <label>Save as</label>
          <select data-format>
            <option value="image/jpeg" selected>JPG — smaller files</option>
            <option value="image/png">PNG — crisp text, best for slides</option>
          </select>
        </div>
        <div class="field" data-qwrap>
          <label>Quality — <span data-q>85</span>%</label>
          <input type="range" min="50" max="95" value="85" data-quality />
        </div>
        <div class="field">
          <label>Width</label>
          <select data-width>
            <option value="0" selected>Original</option>
            <option value="1920">1920 px</option>
            <option value="1280">1280 px</option>
            <option value="640">640 px</option>
          </select>
        </div>
      </div>
      <p class="note" data-plan></p>
      <div class="actions">
        <button class="btn" data-go>Save photos</button>
        <button class="btn secondary" data-reset>Choose another video</button>
      </div>
    </div>
  `);

  const modeSel = controls.querySelector('[data-mode]');
  const intervalSel = controls.querySelector('[data-interval]');
  const countSel = controls.querySelector('[data-count]');
  const timeInput = controls.querySelector('[data-time]');
  const hereBtn = controls.querySelector('[data-here]');
  const formatSel = controls.querySelector('[data-format]');
  const qWrap = controls.querySelector('[data-qwrap]');
  const qSlider = controls.querySelector('[data-quality]');
  const qLabel = controls.querySelector('[data-q]');
  const widthSel = controls.querySelector('[data-width]');
  const planNote = controls.querySelector('[data-plan]');
  const goBtn = controls.querySelector('[data-go]');
  const job = jobProgress({ cancelLabel: 'Stop' });

  modeSel.addEventListener('change', () => {
    controls.querySelector('[data-intervalwrap]').hidden = modeSel.value !== 'interval';
    controls.querySelector('[data-countwrap]').hidden = modeSel.value !== 'count';
    controls.querySelector('[data-onewrap]').hidden = modeSel.value !== 'one';
    updatePlan();
  });
  formatSel.addEventListener('change', () => {
    // PNG is lossless, so its quality slider would do nothing at all.
    qWrap.hidden = formatSel.value !== 'image/jpeg';
    updatePlan();
  });
  qSlider.addEventListener('input', () => { qLabel.textContent = qSlider.value; });
  [intervalSel, countSel, widthSel].forEach((c) => c.addEventListener('change', updatePlan));
  timeInput.addEventListener('input', updatePlan);

  hereBtn.addEventListener('click', () => {
    if (!preview) return;
    timeInput.value = formatDuration(preview.node.currentTime, { decimals: 1 });
    updatePlan();
  });

  controls.querySelector('[data-reset]').addEventListener('click', reset);

  function reset() {
    preview?.destroy();
    preview = null;
    file = null;
    probe = null;
    info.hidden = true;
    info.innerHTML = '';
    controls.hidden = true;
    zone.hidden = false;
    resultsHost.innerHTML = '';
    grid.innerHTML = '';
    grid.hidden = true;
    errorBox(panel, null);
  }

  async function load(f) {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    grid.innerHTML = '';
    grid.hidden = true;
    try {
      probe = await probeMedia(f);
      if (!probe.hasVideo) {
        throw new Error(`${f.name} has no video track, so there are no pictures in it to save.`);
      }
      if (!probe.video.decodable) {
        throw new Error(`This browser cannot open the video inside ${f.name} (${probe.video.codec ?? 'unknown codec'}). Run it through Convert Video first to turn it into MP4.`);
      }
      if (!Number.isFinite(probe.duration) || probe.duration <= 0) {
        throw new Error(`UniLab could not work out how long ${f.name} is, so it cannot pick moments to photograph.`);
      }
      file = f;
      zone.hidden = true;
      info.hidden = false;
      info.innerHTML = '';
      preview?.destroy();
      preview = mediaPreview(f, { kind: 'video', muted: true });
      info.append(preview.node, mediaStats(probe));
      controls.hidden = false;
      timeInput.value = '';
      updatePlan();
    } catch (err) {
      errorBox(panel, err.message);
    }
  }

  /** Output size after the width cap. Never upscales — that just adds blur and bytes. */
  function outputSize() {
    const { width, height } = probe.video;
    const cap = Number(widthSel.value);
    if (!cap || width <= cap) return { width, height, scaled: false };
    return { width: cap, height: Math.round(height * (cap / width)), scaled: true };
  }

  /**
   * The list of moments to photograph, ascending — grabFrames decodes each
   * packet once when the timestamps arrive in order.
   */
  function buildPlan() {
    const duration = probe.duration;
    // A timestamp sitting exactly on the end of the video has no packet behind
    // it, so stay a hair inside or the last photo comes back empty.
    const last = Math.max(0, duration - 0.05);

    if (modeSel.value === 'one') {
      const asked = parseTimecode(timeInput.value);
      if (asked === null) {
        return { error: 'Type the time as 12, 1:15 or 1:02:03 — then hit save.' };
      }
      return { times: [Math.min(asked, last)], wanted: 1, gap: 0, past: asked > last };
    }

    if (modeSel.value === 'count') {
      const n = Number(countSel.value);
      // Half-step offsets rather than 0…duration: the first photo then isn't the
      // black frame the recording opens on, and the last isn't the end card.
      const times = Array.from({ length: n }, (_, i) => Math.min(last, (duration * (i + 0.5)) / n));
      return { times, wanted: n, gap: duration / n };
    }

    const step = Number(intervalSel.value);
    const wanted = Math.max(1, Math.floor(last / step) + 1);
    const n = Math.min(wanted, MAX_FRAMES);
    return {
      times: Array.from({ length: n }, (_, i) => Math.min(last, i * step)),
      wanted,
      gap: step,
      clamped: n < wanted,
      covers: (n - 1) * step,
    };
  }

  function updatePlan() {
    if (!probe) return;
    const plan = buildPlan();
    if (plan.error) {
      planNote.textContent = plan.error;
      goBtn.textContent = 'Save photos';
      goBtn.disabled = true;
      return;
    }
    goBtn.disabled = false;
    const { width, height } = outputSize();
    const count = plan.times.length;

    let text;
    if (modeSel.value === 'one') {
      text = `One photo at ${formatDuration(plan.times[0], { decimals: 1 })}, ${width}×${height}.`;
      if (plan.past) text += ' That is past the end of this video, so you get the very last frame.';
    } else if (plan.clamped) {
      text = `That gap would make ${plan.wanted} photos and UniLab stops at ${MAX_FRAMES}. You will get the first ${MAX_FRAMES} — the first ${formatDuration(plan.covers)} of the video. Choose a bigger gap to cover all of it.`;
    } else if (modeSel.value === 'count') {
      text = `${count} photos spread evenly across the video, ${width}×${height}.`;
    } else {
      const every = plan.gap < 1 ? 'half a second' : plan.gap === 1 ? 'second' : `${plan.gap} seconds`;
      text = `${count} photos, ${width}×${height} — one every ${every}, covering ${formatDuration(plan.covers)} of the video.`;
    }
    planNote.textContent = text;
    goBtn.textContent = count === 1 ? 'Save this photo' : `Save ${count} photos`;
  }

  /**
   * "lecture-01-23-450.jpg". Minutes are padded to a fixed width across the whole
   * run so the photos sit in the right order in a file manager, which sorts by
   * text — "9-…" would otherwise land after "10-…".
   */
  function frameName(seconds, minutePad, ext) {
    const ms = Math.round(seconds * 1000);
    const mm = String(Math.floor(ms / 60000)).padStart(minutePad, '0');
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const mmm = String(ms % 1000).padStart(3, '0');
    return `${stem(file.name)}-${mm}-${ss}-${mmm}.${ext}`;
  }

  /** One card in the grid: a small copy of the frame, its timecode, and a click to save it. */
  function frameCard(source, timestamp, decimals, name, blob) {
    const card = el(`<div class="frame-card" role="button" tabindex="0" style="cursor:pointer"></div>`);
    card.title = `Save ${name}`;

    const thumb = document.createElement('canvas');
    const scale = Math.min(1, THUMB_WIDTH / source.width);
    thumb.width = Math.max(1, Math.round(source.width * scale));
    thumb.height = Math.max(1, Math.round(source.height * scale));
    thumb.getContext('2d').drawImage(source, 0, 0, thumb.width, thumb.height);

    const caption = el(`<div class="t"></div>`);
    caption.textContent = formatDuration(timestamp, { decimals });

    const save = () => { downloadBlob(blob, name); toast(`Saved ${name}`); };
    card.addEventListener('click', save);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); save(); }
    });

    card.append(thumb, caption);
    return card;
  }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    resultsHost.innerHTML = '';
    grid.innerHTML = '';
    const plan = buildPlan();
    if (plan.error) { errorBox(panel, plan.error); return; }

    const mime = formatSel.value;
    const ext = MIME_EXT[mime];
    const jpegQuality = mime === 'image/jpeg' ? Number(qSlider.value) / 100 : undefined;
    const size = outputSize();
    const minutePad = Math.max(2, String(Math.floor(plan.times[plan.times.length - 1] / 60)).length);
    // Photos less than two seconds apart would show the same "0:07" twice, so
    // the caption gains a tenth of a second when the gap is that tight — as does
    // a single hand-picked frame, where the exact moment is the whole point.
    const decimals = plan.gap >= 2 ? 0 : 1;

    goBtn.disabled = true;
    grid.hidden = true;
    const outputs = [];
    // A moment is asked for, but a *frame* is what comes back — the last one at
    // or before that moment. Ask for a photo every half second of a slideshow
    // that only changes once a minute and every one of them is the same frame,
    // under the same filename, which would collide inside the ZIP. Keep the
    // first of each and count the rest so the result card can own up to it.
    const seen = new Set();
    let repeats = 0;
    const signal = job.start('Opening the video…');

    try {
      for await (const { canvas, timestamp, index } of grabFrames(file, plan.times, {
        width: size.scaled ? size.width : undefined,
        signal,
      })) {
        const name = frameName(timestamp, minutePad, ext);
        if (seen.has(name)) {
          repeats++;
        } else {
          seen.add(name);
          const blob = await canvasToBlob(canvas, mime, jpegQuality);
          outputs.push({ name, blob });
          grid.hidden = false;
          grid.appendChild(frameCard(canvas, timestamp, decimals, name, blob));
        }
        job.update((index + 1) / plan.times.length,
          `Photo ${outputs.length} of ${plan.times.length} · ${formatDuration(timestamp)}`);
        await yieldToBrowser();
      }

      // grabFrames returns quietly on cancel instead of throwing, so the stop
      // button lands here — with whatever photos were already saved on screen.
      if (signal.aborted) {
        toast(outputs.length ? 'Stopped — the photos it already took are still on the page' : 'Stopped');
        return;
      }
      if (!outputs.length) {
        throw new Error('No frames came back from that video. It may be damaged, or the moments you picked may all sit past the end of it.');
      }

      await showResult(outputs, plan, ext, repeats);
    } catch (err) {
      if (isCanceled(err)) toast('Stopped');
      else errorBox(panel, err.message);
    } finally {
      job.stop();
      goBtn.disabled = false;
    }
  });

  async function showResult(outputs, plan, ext, repeats) {
    const total = outputs.reduce((sum, o) => sum + o.blob.size, 0);
    const zipName = `${stem(file.name)}-frames.zip`;
    const warnings = [];
    const missing = plan.times.length - outputs.length - repeats;
    if (missing > 0) {
      warnings.push(`${missing} of the ${plan.times.length} moments had no frame to read, so those were skipped.`);
    }
    if (repeats > 0) {
      warnings.push(`${repeats} moments landed on a picture you already have — the video does not change that often — so only the first of each was kept. Spread the photos further apart to get ${plan.times.length} different ones.`);
    }

    let downloads = outputs;
    let message;
    if (outputs.length > BUTTONS_MAX) {
      // One button per photo would be a wall of buttons at this point, so the
      // card offers the ZIP and the grid below covers "I only want that slide".
      job.update(1, `Packing ${outputs.length} photos into a ZIP…`);
      await yieldToBrowser();
      const zip = new JSZip();
      outputs.forEach((o) => zip.file(o.name, o.blob));
      downloads = [{ name: zipName, blob: await zip.generateAsync({ type: 'blob' }) }];
      message = 'The ZIP is the easy one — it holds every photo. For a single shot, click it in the grid below.';
    } else if (outputs.length > 1) {
      message = 'Click any photo in the grid below to save just that one.';
    }

    resultsHost.appendChild(resultCard({
      heading: `✅ ${outputs.length} photo${outputs.length > 1 ? 's' : ''} ready`,
      message,
      stats: [
        [String(outputs.length), outputs.length === 1 ? 'Photo' : 'Photos'],
        [ext.toUpperCase(), 'Format'],
        [formatBytes(total), 'Total size'],
      ],
      outputs: downloads,
      warnings,
      zipName,
    }));
  }

  // The preview holds a blob URL over the whole video, and a lecture recording
  // can be a couple of gigabytes. Leaving for another tool has to hand it back,
  // or the browser keeps the file in memory for the rest of the session.
  window.addEventListener('hashchange', () => {
    preview?.destroy();
    preview = null;
  }, { once: true });

  panel.append(zone, info, controls, job.root);
  container.append(panel, resultsHost, grid);
  container.appendChild(el(`
    <p class="note">Missed a slide in a lecture recording? Play the video above, pause on
    the slide, switch to "just one photo" and press "use the playback position" — save it
    as PNG and the text stays sharp enough to read in your notes. The video is read
    straight off this device and never uploaded.</p>
  `));
}
