import { el, dropzone, formatBytes, errorBox, stem, toast } from '../ui.js';
import {
  AUDIO_ACCEPT, CONTAINERS, convertMedia, ensureMp3Encoder, formatDuration,
  isCanceled, pickAudioCodec, probeMedia, quality, requireWebCodecs, yieldToBrowser,
} from '../media-utils.js';
import { jobProgress, mediaPreview, resultCard } from '../media-ui.js';

const BITRATES = [
  { label: '320 kbps — as good as MP3 gets', bps: 320_000 },
  { label: '192 kbps — right for music', bps: 192_000 },
  { label: '128 kbps — good for anything', bps: 128_000 },
  { label: '96 kbps — smaller', bps: 96_000 },
  { label: '64 kbps — speech only', bps: 64_000 },
];
const DEFAULT_BITRATE = 192_000;
const SAFE_BITRATE = 128_000;

const SAMPLE_RATES = [
  { label: 'Keep original', hz: 0 },
  { label: '44100 Hz — CD quality', hz: 44100 },
  { label: '22050 Hz — smaller', hz: 22050 },
  { label: '16000 Hz — speech', hz: 16000 },
];

// 16-bit samples, so every second of WAV costs 2 bytes per channel per sample.
const WAV_BYTES_PER_SAMPLE = 2;

// Under 32 kHz an MP3 becomes MPEG-2 Layer III, whose highest legal bitrate is
// 160 kbps — 320 and 192 cannot be written there at all. The other formats do
// accept them, but a 16 kHz file has nothing above 8 kHz left to spend those
// bytes on either, so the honest thing is to take the choice away everywhere.
const LOW_RATE_LIMIT = 32000;
const LOW_RATE_CEILING = 160_000;

export default function render(container) {
  if (!requireWebCodecs(container)) return;

  const panel = el(`<div class="panel"></div>`);
  const resultsHost = el(`<div></div>`);
  /** @type {{ file: File, probe: object }[]} */
  const items = [];
  let resultPreview = null;

  const zone = dropzone({
    accept: AUDIO_ACCEPT,
    multiple: true,
    label: 'Choose your recordings',
    hint: 'M4A, WAV, OGG, FLAC or MP3 — as many as you like',
    onFiles: add,
  });

  const listRoot = el(`<div class="file-list"></div>`);
  const rejects = el(`<div></div>`);

  const controls = el(`
    <div class="controls">
      <div class="field">
        <label>Save as</label>
        <select data-format>
          <option value="mp3" selected>MP3 — opens on everything</option>
          <option value="m4a">M4A — same quality, a bit smaller</option>
          <option value="wav">WAV — uncompressed, for editing</option>
          <option value="ogg">OGG — smallest for speech</option>
        </select>
      </div>
      <div class="field">
        <label>Bitrate</label>
        <select data-bitrate></select>
      </div>
      <div class="field">
        <label>Sample rate</label>
        <select data-rate></select>
      </div>
      <label class="checkbox"><input type="checkbox" data-mono /> Mono</label>
    </div>
  `);

  const formatSel = controls.querySelector('[data-format]');
  const bitrateSel = controls.querySelector('[data-bitrate]');
  const rateSel = controls.querySelector('[data-rate]');
  const monoBox = controls.querySelector('[data-mono]');

  BITRATES.forEach((b, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = b.label;
    if (b.bps === DEFAULT_BITRATE) o.selected = true;
    bitrateSel.appendChild(o);
  });
  SAMPLE_RATES.forEach((r, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = r.label;
    rateSel.appendChild(o);
  });

  const estimate = el(`<p class="note" hidden></p>`);
  const actions = el(`
    <div class="actions">
      <button class="btn" data-go disabled>Convert audio</button>
      <button class="btn secondary" data-reset hidden>Start over</button>
    </div>
  `);
  const goBtn = actions.querySelector('[data-go]');
  const resetBtn = actions.querySelector('[data-reset]');
  const job = jobProgress();

  [formatSel, bitrateSel, rateSel, monoBox].forEach((c) => c.addEventListener('change', () => {
    syncBitrateChoices();
    updateEstimate();
  }));
  resetBtn.addEventListener('click', reset);

  function sampleRate() {
    return SAMPLE_RATES[Number(rateSel.value)].hz;
  }

  function bitrate() {
    return BITRATES[Number(bitrateSel.value)].bps;
  }

  /** Greys out the bitrates the current sample rate and format can't honour. */
  function syncBitrateChoices() {
    // WAV writes every sample in full — there is no bitrate to pick, and a live
    // control that changes nothing is worse than a dead one.
    bitrateSel.disabled = formatSel.value === 'wav';
    const ceiling = sampleRate() && sampleRate() < LOW_RATE_LIMIT ? LOW_RATE_CEILING : Infinity;
    BITRATES.forEach((b, i) => { bitrateSel.options[i].disabled = b.bps > ceiling; });
    if (bitrate() > ceiling) bitrateSel.value = String(BITRATES.findIndex((b) => b.bps === SAFE_BITRATE));
  }

  /**
   * Reads each dropped file before accepting it. A file UniLab can't open is
   * turned away on its own line rather than failing the whole drop — students
   * select a folder, and one stray .wma shouldn't cost them the other nine.
   */
  async function add(files) {
    errorBox(panel, null);
    rejects.innerHTML = '';
    goBtn.disabled = true;
    goBtn.textContent = 'Reading files…';

    for (const file of files) {
      // Reading a folder of recordings is a long loop of its own, so it hands
      // control back between files instead of freezing the page.
      await yieldToBrowser();
      try {
        const probe = await probeMedia(file);
        if (!probe.hasAudio) throw new Error('has no sound in it, so there is nothing to convert.');
        if (probe.audio.decodable === false) throw new Error(`is ${probe.audio.codec ?? 'an audio format'} this browser cannot open. Try it in Chrome or Edge.`);
        if (!(probe.duration > 0)) throw new Error('is empty — it has no length, so there is nothing to convert.');
        items.push({ file, probe });
      } catch (err) {
        // probeMedia's own errors already start with the filename; ours are
        // written to read as "<name> has no sound in it."
        const line = el(`<p class="note warn-note"></p>`);
        line.textContent = err.message.startsWith(file.name) ? `⚠ ${err.message}` : `⚠ ${file.name} ${err.message}`;
        rejects.appendChild(line);
      }
    }

    goBtn.textContent = 'Convert audio';
    renderList();
    updateEstimate();
  }

  function renderList() {
    listRoot.innerHTML = '';
    items.forEach((item, i) => {
      const row = el(`<div class="file-row"><span>🎵</span><span class="name"></span><span class="size"></span></div>`);
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

  /** What the whole batch should weigh afterwards, in bytes. */
  function estimateBytes() {
    if (formatSel.value === 'wav') {
      return items.reduce((total, { probe }) => {
        const channels = monoBox.checked ? 1 : probe.audio.channels;
        return total + probe.duration * (sampleRate() || probe.audio.sampleRate) * channels * WAV_BYTES_PER_SAMPLE;
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
    // Said against what they already have, because "about 30 MB" only means
    // something next to the 1 GB sitting in their Downloads folder.
    const change = out <= sourceBytes
      ? `${Math.round((1 - out / sourceBytes) * 100)}% smaller`
      : `${(out / Math.max(1, sourceBytes)).toFixed(1)}× bigger than what you have now`;
    estimate.textContent = `${items.length} ${items.length === 1 ? 'file' : 'files'} · ${formatDuration(seconds)} · ${formatBytes(sourceBytes)} now`
      + ` → about ${formatBytes(out)} as ${CONTAINERS[formatSel.value].label} (${change}).`;
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
   * `lecture.m4a` and `lecture.wav` both want to be `lecture.mp3`, and JSZip
   * would quietly keep only the last one. Number the clashes instead.
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
    // runs, and reading them inside the loop would hand file 1 and file 8
    // different settings — and label the result card with whichever format the
    // menu happened to be showing at the end.
    const containerId = formatSel.value;
    const formatLabel = CONTAINERS[containerId].label;
    const mono = monoBox.checked;
    const bps = bitrate();
    const hz = sampleRate();
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
          // Asked per file, because "Keep original" means each recording puts a
          // different question to the browser's encoder list.
          const codec = await pickAudioCodec(containerId, {
            numberOfChannels: mono ? 1 : probe.audio.channels,
            sampleRate: hz || probe.audio.sampleRate,
          });

          const result = await convertMedia({
            file,
            container: containerId,
            audio: {
              codec,
              // PCM has no bitrate setting — every sample is written in full —
              // so asking for one here would be ignored at best.
              ...(containerId === 'wav' ? {} : { quality: quality(bps) }),
              numberOfChannels: mono ? 1 : undefined,
              sampleRate: hz || undefined,
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
        toast('Conversion canceled');
      } else {
        errorBox(panel, `None of these files could be converted. ${warnings.join(' ')}`);
      }
    } catch (err) {
      job.stop();
      if (isCanceled(err)) toast('Conversion canceled');
      else errorBox(panel, err.message);
    } finally {
      goBtn.disabled = items.length === 0;
    }
  });

  function showResults({ outputs, warnings, sourceBytes, canceled, total, formatLabel: label, elapsedMs }) {
    const outBytes = outputs.reduce((sum, o) => sum + o.blob.size, 0);
    const saved = sourceBytes ? Math.round((1 - outBytes / sourceBytes) * 100) : 0;

    // A single file gets a player, so you can hear that the lecturer is still
    // clear at 16 kHz before you delete the original.
    let preview;
    if (outputs.length === 1) {
      const [only] = outputs;
      resultPreview = mediaPreview(new File([only.blob], only.name, { type: only.blob.type }), { kind: 'audio' });
      preview = resultPreview.node;
    }

    resultsHost.appendChild(resultCard({
      heading: canceled
        ? `✅ Stopped early — ${outputs.length} of ${total} done`
        : saved > 0 ? `✅ Done — ${saved}% smaller` : `✅ Done — converted to ${label}`,
      message: canceled
        ? 'These finished before you canceled. The rest are still in the list if you want to run them again.'
        : saved > 0
          ? `Every file is now ${label}. Took ${(elapsedMs / 1000).toFixed(1)}s.`
          : `These came out bigger than what you started with, which is normal for ${label} or a higher bitrate than the original had. Keep your originals unless you needed the format change.`,
      stats: [
        [String(outputs.length), outputs.length === 1 ? 'File' : 'Files'],
        [formatBytes(sourceBytes), 'Before'],
        [formatBytes(outBytes), 'After'],
        [`${Math.max(0, saved)}%`, 'Saved'],
      ],
      outputs,
      warnings,
      zipName: 'unilab-audio-converted.zip',
      preview,
    }));
  }

  syncBitrateChoices();

  // Leaving the page mid-job would otherwise keep the finished player's blob URL
  // — a whole recording's worth of audio — alive for the rest of the session.
  window.addEventListener('hashchange', () => { resultPreview?.destroy(); resultPreview = null; }, { once: true });

  panel.append(zone, listRoot, rejects, controls, estimate, actions, job.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`
    <p class="note">Speech and music want opposite settings. A lecture at 64 kbps
    mono, 16000 Hz sounds exactly the same to your ear and turns a 1 GB recording
    into roughly 30 MB — a whole semester fits on your phone. For music, stay in
    stereo at 192 kbps. Either way the files never leave this device.</p>
  `));
}
