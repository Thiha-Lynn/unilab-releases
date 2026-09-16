import { el, dropzone, formatBytes, errorBox, stem, toast } from '../ui.js';
import {
  VIDEO_ACCEPT, CONTAINERS, convertMedia, ensureMp3Encoder, formatDuration,
  isCanceled, pickAudioCodec, probeMedia, quality, requireWebCodecs, yieldToBrowser,
} from '../media-utils.js';
import { jobProgress, mediaPreview, resultCard } from '../media-ui.js';

// Speech, not music. 128 kbps is the safe default; 64 is where an hour-long
// lecture drops under 30 MB and still sounds perfectly clear.
const BITRATES = [
  { label: '320 kbps — music quality', bps: 320_000 },
  { label: '192 kbps — very clear', bps: 192_000 },
  { label: '128 kbps — good for anything', bps: 128_000 },
  { label: '96 kbps — smaller', bps: 96_000 },
  { label: '64 kbps — smallest, speech only', bps: 64_000 },
];

// 16-bit samples, so every second of WAV costs 2 bytes per channel per sample.
const WAV_BYTES_PER_SAMPLE = 2;

export default function render(container) {
  if (!requireWebCodecs(container)) return;

  const panel = el(`<div class="panel"></div>`);
  const resultsHost = el(`<div></div>`);
  /** @type {{ file: File, probe: object }[]} */
  const items = [];
  let resultPreview = null;

  const zone = dropzone({
    accept: VIDEO_ACCEPT,
    multiple: true,
    label: 'Choose your lecture videos',
    hint: 'MP4, MOV, WebM or MKV — a whole week of classes at once',
    onFiles: add,
  });

  const listRoot = el(`<div class="file-list"></div>`);
  const rejects = el(`<div></div>`);

  const controls = el(`
    <div class="controls">
      <div class="field">
        <label>Save as</label>
        <select data-format>
          <option value="mp3" selected>MP3 — plays on everything</option>
          <option value="m4a">M4A — same quality, a bit smaller</option>
          <option value="wav">WAV — uncompressed, very big</option>
          <option value="ogg">OGG — smallest for speech</option>
        </select>
      </div>
      <div class="field" data-bitratewrap>
        <label>Sound quality</label>
        <select data-bitrate></select>
      </div>
      <label class="checkbox"><input type="checkbox" data-mono checked /> Mono (smaller, fine for speech)</label>
    </div>
  `);

  const formatSel = controls.querySelector('[data-format]');
  const bitrateWrap = controls.querySelector('[data-bitratewrap]');
  const bitrateSel = controls.querySelector('[data-bitrate]');
  const monoBox = controls.querySelector('[data-mono]');
  BITRATES.forEach((b, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = b.label;
    if (b.bps === 128_000) o.selected = true;
    bitrateSel.appendChild(o);
  });

  const estimate = el(`<p class="note" hidden></p>`);
  const actions = el(`
    <div class="actions">
      <button class="btn" data-go disabled>Extract audio</button>
      <button class="btn secondary" data-reset hidden>Start over</button>
    </div>
  `);
  const goBtn = actions.querySelector('[data-go]');
  const resetBtn = actions.querySelector('[data-reset]');
  const job = jobProgress();

  formatSel.addEventListener('change', () => {
    // WAV is uncompressed — there is no bitrate to pick, and showing a dead
    // control that changes nothing is worse than showing none.
    bitrateWrap.hidden = formatSel.value === 'wav';
    updateEstimate();
  });
  bitrateSel.addEventListener('change', updateEstimate);
  monoBox.addEventListener('change', updateEstimate);
  resetBtn.addEventListener('click', reset);

  function bitrate() {
    return BITRATES[Number(bitrateSel.value)].bps;
  }

  /**
   * Reads each dropped file before accepting it. A file with no sound track is
   * turned away with its own line rather than failing the whole drop — students
   * grab a folder of recordings and one silent screen capture shouldn't cost
   * them the other four.
   */
  async function add(files) {
    errorBox(panel, null);
    rejects.innerHTML = '';
    goBtn.disabled = true;
    goBtn.textContent = 'Reading files…';

    for (const file of files) {
      // Reading a folder of lecture recordings is a long loop of its own, so it
      // hands control back between files instead of freezing the page.
      await yieldToBrowser();
      try {
        const probe = await probeMedia(file);
        if (!probe.hasAudio) throw new Error('has no sound track — there is nothing to pull out of it.');
        if (probe.audio.decodable === false) throw new Error(`uses ${probe.audio.codec ?? 'an'} audio this browser cannot decode. Convert it to MP4 first, then come back.`);
        if (!(probe.duration > 0)) throw new Error('is empty — it has no length, so there is no sound to pull out.');
        items.push({ file, probe });
      } catch (err) {
        // probeMedia's own errors already name the file; ours are written to
        // read as "<name> has no sound track."
        const line = el(`<p class="note warn-note"></p>`);
        line.textContent = err.message.startsWith(file.name) ? `⚠ ${err.message}` : `⚠ ${file.name} ${err.message}`;
        rejects.appendChild(line);
      }
    }

    goBtn.textContent = 'Extract audio';
    renderList();
    updateEstimate();
  }

  function renderList() {
    listRoot.innerHTML = '';
    items.forEach((item, i) => {
      const row = el(`<div class="file-row"><span>🎬</span><span class="name"></span><span class="size"></span></div>`);
      row.querySelector('.name').textContent = item.file.name;
      row.querySelector('.size').textContent = `${formatDuration(item.probe.duration)} · ${formatBytes(item.file.size)}`;
      const rm = el(`<button class="icon-btn danger" title="Remove">✕</button>`);
      rm.addEventListener('click', () => {
        items.splice(i, 1);
        renderList();
        updateEstimate();
      });
      row.append(rm);
      listRoot.appendChild(row);
    });
  }

  /** What the finished audio should weigh, in bytes, for the current settings. */
  function estimateBytes() {
    if (formatSel.value === 'wav') {
      return items.reduce((total, { probe }) => {
        const channels = monoBox.checked ? 1 : probe.audio.channels;
        return total + probe.duration * probe.audio.sampleRate * channels * WAV_BYTES_PER_SAMPLE;
      }, 0);
    }
    const seconds = items.reduce((total, { probe }) => total + probe.duration, 0);
    return (bitrate() * seconds) / 8;
  }

  function updateEstimate() {
    goBtn.disabled = items.length === 0;
    resetBtn.hidden = items.length === 0;
    estimate.hidden = items.length === 0;
    if (!items.length) return;

    const sourceBytes = items.reduce((total, { file }) => total + file.size, 0);
    const seconds = items.reduce((total, { probe }) => total + probe.duration, 0);
    const out = estimateBytes();
    const saved = sourceBytes ? Math.round((1 - out / sourceBytes) * 100) : 0;
    const label = CONTAINERS[formatSel.value].label;
    estimate.textContent = `${items.length} ${items.length === 1 ? 'video' : 'videos'} · ${formatDuration(seconds)} · ${formatBytes(sourceBytes)} of video`
      + ` → about ${formatBytes(out)} of ${label}${saved > 0 ? ` (${saved}% smaller)` : ''}.`;
  }

  function reset() {
    items.length = 0;
    rejects.innerHTML = '';
    renderList();
    updateEstimate();
    clearResults();
    errorBox(panel, null);
  }

  function clearResults() {
    resultPreview?.destroy();
    resultPreview = null;
    resultsHost.innerHTML = '';
  }

  /**
   * Two videos called `week1.mp4` and `week1.mov` both want to be `week1.mp3`,
   * and JSZip would quietly keep only the last one. Number the clashes instead.
   */
  function uniqueName(taken, name) {
    if (!taken.has(name)) { taken.add(name); return name; }
    const base = stem(name);
    const ext = name.slice(base.length);
    let n = 2;
    while (taken.has(`${base}-${n}${ext}`)) n++;
    taken.add(`${base}-${n}${ext}`);
    return `${base}-${n}${ext}`;
  }

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    clearResults();
    goBtn.disabled = true;
    const started = performance.now();
    const signal = job.start('Preparing…');

    // Every setting is read once, here. The controls stay live while the batch
    // runs, and reading them inside the loop would give file 1 and file 8
    // different settings — and label the result card with whichever format the
    // menu happened to be showing at the end.
    const containerId = formatSel.value;
    const formatLabel = CONTAINERS[containerId].label;
    const mono = monoBox.checked;
    const bps = bitrate();
    // The list keeps its own remove buttons while the batch runs, so iterate a
    // snapshot — otherwise removing a row mid-run shifts every later index and
    // the wrong file gets converted.
    const queue = items.slice();
    const total = queue.length;
    const outputs = [];
    const warnings = [];
    const taken = new Set();
    let sourceBytes = 0;
    let canceled = false;

    try {
      // The LAME encoder is a lazy ~200 KB download. Pulling it in once here
      // keeps it out of the per-file loop, where it would look like a stall.
      if (containerId === 'mp3') await ensureMp3Encoder();

      for (let i = 0; i < total; i++) {
        if (signal.aborted) { canceled = true; break; }
        // Between files, so the Cancel button and the progress bar can actually
        // repaint on a long batch.
        await yieldToBrowser();
        const { file, probe } = queue[i];
        const position = `file ${i + 1} of ${total}`;
        job.update(i / total, `${position} — 0%`);

        try {
          const channels = mono ? 1 : probe.audio.channels;
          const codec = await pickAudioCodec(containerId, {
            numberOfChannels: channels,
            sampleRate: probe.audio.sampleRate,
          });

          const result = await convertMedia({
            file,
            container: containerId,
            video: { discard: true },
            audio: {
              codec,
              // PCM has no bitrate setting — every sample is written in full —
              // so asking for one here would be ignored at best.
              ...(containerId === 'wav' ? {} : { quality: quality(bps) }),
              numberOfChannels: mono ? 1 : undefined,
            },
            onProgress: (fraction) => {
              job.update((i + fraction) / total, `${position} — ${Math.round(fraction * 100)}%`);
            },
            signal,
          });

          outputs.push({ name: uniqueName(taken, `${stem(file.name)}.${result.ext}`), blob: result.blob });
          sourceBytes += file.size;
          for (const w of result.warnings) warnings.push(`${file.name} — ${w}`);
        } catch (err) {
          if (isCanceled(err)) { canceled = true; break; }
          // One bad file must not cost the student the rest of the batch.
          warnings.push(`${file.name} was skipped: ${err.message}`);
        }
      }

      job.stop();

      if (outputs.length) {
        if (canceled) toast(`Stopped — keeping the ${outputs.length} ${outputs.length === 1 ? 'file' : 'files'} that finished`);
        showResults({ outputs, warnings, sourceBytes, canceled, total, formatLabel, elapsedMs: performance.now() - started });
      } else if (canceled) {
        toast('Extraction canceled');
      } else {
        errorBox(panel, `None of these files could be converted. ${warnings.join(' ')}`);
      }
    } catch (err) {
      job.stop();
      if (isCanceled(err)) toast('Extraction canceled');
      else errorBox(panel, err.message);
    } finally {
      goBtn.disabled = items.length === 0;
    }
  });

  function showResults({ outputs, warnings, sourceBytes, canceled, total, formatLabel, elapsedMs }) {
    const audioBytes = outputs.reduce((sum, o) => sum + o.blob.size, 0);
    // WAV is uncompressed, so an hour of sound pulled out of a compressed video
    // genuinely comes out bigger than the video was. Saying "0% smaller" there
    // reads like a broken tool rather than the honest answer.
    const grew = audioBytes >= sourceBytes;
    const saved = sourceBytes && !grew ? Math.round((1 - audioBytes / sourceBytes) * 100) : 0;

    // One file gets a player, so you can check the lecturer is actually audible
    // before you delete the video.
    let preview;
    if (outputs.length === 1) {
      const [only] = outputs;
      resultPreview = mediaPreview(new File([only.blob], only.name, { type: only.blob.type }), { kind: 'audio' });
      preview = resultPreview.node;
    }

    resultsHost.appendChild(resultCard({
      heading: canceled
        ? `✅ Stopped early — ${outputs.length} of ${total} done`
        : grew ? `✅ Done — ${formatLabel} sound only` : `✅ Done — ${saved}% smaller`,
      message: canceled
        ? 'These finished before you canceled. The rest of the videos are still in the list if you want to run them again.'
        : grew
          ? `The sound alone came out bigger than the videos were — that happens with WAV, which keeps every sample, and with a sound quality set higher than the video's own audio had. Pick MP3 or OGG at 64 or 96 kbps if you want something small to carry around.`
          : `Sound only, ready for the bus. Took ${(elapsedMs / 1000).toFixed(1)}s.`,
      stats: [
        [String(outputs.length), outputs.length === 1 ? 'File' : 'Files'],
        [formatBytes(sourceBytes), 'Video'],
        [formatBytes(audioBytes), 'Audio'],
        [grew ? '—' : `${saved}%`, 'Saved'],
      ],
      outputs,
      warnings,
      zipName: 'unilab-audio.zip',
      preview,
    }));
  }

  // Leaving the page mid-job would otherwise keep the finished player's blob URL
  // — a whole lecture's worth of audio — alive for the rest of the session.
  window.addEventListener('hashchange', () => { resultPreview?.destroy(); resultPreview = null; }, { once: true });

  panel.append(zone, listRoot, rejects, controls, estimate, actions, job.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`
    <p class="note">A lecture is speech, not music. 64 kbps mono still sounds clear
    and turns a one-hour recording into about 29 MB — small enough to keep a whole
    semester on your phone and listen to on the songthaew. The videos never leave
    this device.</p>
  `));
}
