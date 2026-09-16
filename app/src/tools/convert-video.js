import { el, dropzone, errorBox, formatBytes, stem, toast } from '../ui.js';
import {
  VIDEO_ACCEPT, CONTAINERS, CONTAINER_AUDIO_CODEC, CONTAINER_VIDEO_CODEC,
  convertMedia, evenSize, formatDuration, isCanceled, pickAudioCodec,
  pickVideoCodec, probeMedia, requireWebCodecs, yieldToBrowser,
} from '../media-utils.js';
import { jobProgress, mediaPreview, resultCard } from '../media-ui.js';

// The video codecs each container can carry across untouched. MP4 is the odd
// one out: it may legally hold H.265, VP9 or AV1, but a file like that still
// refuses to play in half the browsers and LMS players a student will meet —
// which is the exact problem they opened this tool to fix. So an MP4 only lets
// H.264 through, and anything else is rebuilt as H.264.
const KEEPS_VIDEO_AS_IS = {
  mp4: ['avc'],
  mov: ['avc', 'hevc'],
  mkv: ['avc', 'hevc', 'vp9', 'vp8', 'av1'],
  webm: ['vp9', 'vp8', 'av1'],
};

// The same idea for sound. An MP4 is *allowed* to carry an Opus track, and
// Mediabunny will happily copy one in — but PowerPoint, QuickTime and most
// phones then play the video in silence, which is the single most confusing way
// for this tool to fail. So an MP4 or MOV only lets AAC through. MKV is for
// archiving, so it keeps whatever it was given.
const KEEPS_AUDIO_AS_IS = {
  mp4: ['aac'],
  mov: ['aac'],
  mkv: ['aac', 'opus', 'vorbis', 'mp3', 'flac'],
  webm: ['opus', 'vorbis'],
};

// MP4 and MOV can record "this was filmed sideways" as a note next to the
// picture. MKV and WebM cannot in a way players respect, so a rotated phone clip
// going into one of those has to be redrawn upright — a real re-encode, even
// when the codec itself could have been carried straight across.
const KEEPS_ROTATION = { mp4: true, mov: true, mkv: false, webm: false };

const CODEC_NAMES = { avc: 'H.264', hevc: 'H.265 (HEVC)', vp8: 'VP8', vp9: 'VP9', av1: 'AV1' };
const AUDIO_CODEC_NAMES = { aac: 'AAC', opus: 'Opus', vorbis: 'Vorbis', mp3: 'MP3', flac: 'FLAC' };

// Cap applies to the *shorter* side, so a portrait phone video shot at
// 1080×1920 counts as 1080p and comes out portrait, not squashed.
const RESOLUTIONS = [
  { label: 'Keep original', cap: 0 },
  { label: '1080p', cap: 1080 },
  { label: '720p', cap: 720 },
  { label: '480p', cap: 480 },
];

const FRAME_RATES = [
  { label: 'Keep original', fps: 0 },
  { label: '30 fps', fps: 30 },
  { label: '24 fps', fps: 24 },
];

export default function render(container) {
  if (!requireWebCodecs(container)) return;

  const panel = el(`<div class="panel"></div>`);
  const resultsHost = el(`<div></div>`);
  const items = [];          // { file, probe, error } — one row each
  let resultPreview = null;  // the player on the result card, needs its blob URL revoked
  // True while the queue is running. Probing a file that was dropped in
  // mid-conversion also calls updatePlan(), and without this the Convert button
  // would come back to life and let a second queue start on top of the first.
  let busy = false;

  const zone = dropzone({
    accept: VIDEO_ACCEPT,
    multiple: true,
    label: 'Choose videos',
    hint: 'MOV, MKV, WebM or MP4 — add as many as you like',
    onFiles: addFiles,
  });

  const list = el(`<div class="file-list"></div>`);

  const controls = el(`
    <div hidden>
      <div class="controls">
        <div class="field">
          <label>Save as</label>
          <select data-format>
            <option value="mp4" selected>MP4 — plays everywhere</option>
            <option value="webm">WebM — smaller, web only</option>
            <option value="mov">MOV — QuickTime, Apple</option>
            <option value="mkv">MKV — good for archiving</option>
          </select>
        </div>
        <div class="field">
          <label>Resolution</label>
          <select data-res></select>
        </div>
        <div class="field">
          <label>Frame rate</label>
          <select data-fps></select>
        </div>
        <label class="checkbox"><input type="checkbox" data-mute /> Remove the audio</label>
      </div>
      <p class="note" data-plan></p>
      <div class="actions">
        <button class="btn" data-go>Convert video</button>
        <button class="btn secondary" data-clear>Clear the list</button>
      </div>
    </div>
  `);

  const formatSel = controls.querySelector('[data-format]');
  const resSel = controls.querySelector('[data-res]');
  const fpsSel = controls.querySelector('[data-fps]');
  const muteBox = controls.querySelector('[data-mute]');
  const planNote = controls.querySelector('[data-plan]');
  const goBtn = controls.querySelector('[data-go]');
  const job = jobProgress();

  RESOLUTIONS.forEach((r, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = r.label;
    resSel.appendChild(o);
  });
  FRAME_RATES.forEach((r, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = r.label;
    fpsSel.appendChild(o);
  });

  const clearBtn = controls.querySelector('[data-clear]');

  [formatSel, resSel, fpsSel, muteBox].forEach((c) => c.addEventListener('change', updatePlan));
  clearBtn.addEventListener('click', () => {
    items.length = 0;
    renderList();
    updatePlan();
    clearResult();
    errorBox(panel, null);
  });

  // -------------------------------------------------------------------------
  // The file list
  // -------------------------------------------------------------------------

  function addFiles(files) {
    errorBox(panel, null);
    for (const file of files) {
      // Mediabunny can't read AVI or WMV at all, so say that here rather than
      // letting the file sit in the list until Convert fails on it.
      const error = /\.(avi|wmv)$/i.test(file.name)
        ? 'UniLab cannot read AVI or WMV files — those need a desktop app like VLC.'
        : null;
      items.push({ file, probe: null, error });
    }
    renderList();
    updatePlan();
    probePending();
  }

  let probing = false;
  /**
   * Reads each new file's length and resolution so the row can show them, one
   * file at a time — opening ten large files at once is how a phone runs out of
   * memory before anything has even been converted.
   */
  async function probePending() {
    if (probing) return;
    probing = true;
    try {
      for (const item of items) {
        if (item.probe || item.error) continue;
        try {
          // The frame rate is worth the extra packet scan: it decides whether
          // "30 fps" is a real change for this file or a no-op.
          const probe = await probeMedia(item.file, { frameRate: true });
          if (!probe.hasVideo) throw new Error('This file has sound but no picture — Convert Audio is the tool for it.');
          item.probe = probe;
        } catch (err) {
          item.error = err.message;
        }
        renderList();
        updatePlan();
        // Reading ten files back to back is a long loop like any other — hand
        // the tab back so the rows repaint and the page still answers a tap.
        await yieldToBrowser();
      }
    } finally {
      probing = false;
    }
  }

  function renderList() {
    list.innerHTML = '';
    items.forEach((item, i) => {
      const row = el(`
        <div class="file-row">
          <span>🎬</span>
          <span class="name"></span>
          <span class="size"></span>
        </div>
      `);
      row.querySelector('.name').textContent = item.file.name;

      const meta = row.querySelector('.size');
      if (item.error) {
        meta.classList.add('warn-note');
        meta.style.whiteSpace = 'normal';
        meta.textContent = item.error;
      } else if (item.probe) {
        const { duration, video } = item.probe;
        meta.textContent = `${formatDuration(duration)} · ${video.width}×${video.height} · ${formatBytes(item.file.size)}`;
      } else {
        meta.textContent = `Reading… · ${formatBytes(item.file.size)}`;
      }

      const remove = el(`<button class="icon-btn danger" title="Remove">✕</button>`);
      // The running queue works from a snapshot taken when Convert was pressed,
      // so pulling a row out mid-job would not stop that file converting — it
      // would just make the results list look wrong.
      remove.disabled = busy;
      remove.addEventListener('click', () => {
        items.splice(i, 1);
        renderList();
        updatePlan();
      });
      row.append(remove);
      list.appendChild(row);
    });
  }

  const readyItems = () => items.filter((it) => it.probe && !it.error);

  // -------------------------------------------------------------------------
  // What will happen to each file
  // -------------------------------------------------------------------------

  /**
   * Works out, for one file, whether this is a plain container swap or a real
   * re-encode. That distinction is the whole tool: a swap is a second, a
   * re-encode is minutes.
   */
  function planFor(probe) {
    const { cap } = RESOLUTIONS[Number(resSel.value)];
    const { width, height, codec, frameRate, rotation } = probe.video;
    const plan = { width, height, scaled: false, frameRate: 0, recodedFrom: null, uprighted: false };

    if (cap && Math.min(width, height) > cap) {
      const scale = cap / Math.min(width, height);
      plan.width = evenSize(width * scale);
      plan.height = evenSize(height * scale);
      plan.scaled = true;
    }

    // Frame rate only ever comes down. Writing a 24 fps lecture recording out
    // at 30 invents frames that were never filmed — it costs time and gains
    // nothing, so "30 fps" means "no more than 30".
    const wanted = FRAME_RATES[Number(fpsSel.value)].fps;
    if (wanted && (!frameRate || frameRate > wanted + 0.5)) plan.frameRate = wanted;

    if (!KEEPS_VIDEO_AS_IS[formatSel.value].includes(codec)) plan.recodedFrom = codec;
    plan.uprighted = !!rotation && !KEEPS_ROTATION[formatSel.value];
    plan.encode = plan.scaled || !!plan.frameRate || !!plan.recodedFrom || plan.uprighted;

    // Sound is decided separately: rebuilding a soundtrack takes seconds even
    // when the picture is copied straight across, so it never turns a swap into
    // a long job.
    plan.recodedAudioFrom = probe.hasAudio && !KEEPS_AUDIO_AS_IS[formatSel.value].includes(probe.audio.codec)
      ? probe.audio.codec
      : null;
    return plan;
  }

  function updatePlan() {
    const ready = readyItems();
    const anyRows = items.length > 0;
    controls.hidden = !anyRows;
    goBtn.disabled = busy || ready.length === 0;
    goBtn.textContent = ready.length > 1 ? `Convert ${ready.length} videos` : 'Convert video';
    if (!ready.length) { planNote.textContent = ''; return; }

    const plans = ready.map((it) => planFor(it.probe));
    const encodes = plans.filter((p) => p.encode).length;
    const parts = [];

    if (!encodes) {
      parts.push('Straight container swap — nothing is re-encoded, so this takes about a second per file and the picture stays exactly as it was.');
    } else if (encodes === plans.length) {
      parts.push(`${plans.length === 1 ? 'This file has' : `All ${plans.length} files have`} to be re-encoded, so this is minutes rather than seconds.`);
    } else {
      parts.push(`${encodes} of ${plans.length} files have to be re-encoded (minutes, not seconds) — the rest are a one-second swap.`);
    }

    const rebuilt = [...new Set(plans.filter((p) => p.recodedFrom).map((p) => CODEC_NAMES[p.recodedFrom] ?? p.recodedFrom))];
    if (rebuilt.length) {
      const target = CODEC_NAMES[CONTAINER_VIDEO_CODEC[formatSel.value]];
      parts.push(`${rebuilt.join(' and ')} video cannot just be dropped into a ${CONTAINERS[formatSel.value].label} that plays everywhere, so it is rebuilt as ${target}.`);
    }

    if (plans.some((p) => p.uprighted)) {
      parts.push(`A video filmed sideways cannot be marked as sideways inside a ${CONTAINERS[formatSel.value].label}, so it has to be redrawn upright — that is what makes it a re-encode. Saving as MP4 or MOV avoids it.`);
    }

    if (!muteBox.checked && plans.some((p) => p.recodedAudioFrom)) {
      const target = AUDIO_CODEC_NAMES[CONTAINER_AUDIO_CODEC[formatSel.value]] ?? CONTAINER_AUDIO_CODEC[formatSel.value];
      parts.push(`The sound is rebuilt as ${target}, otherwise the video would come out silent on a phone or in PowerPoint. That part only takes a few seconds.`);
    }
    planNote.textContent = parts.join(' ');
  }

  // -------------------------------------------------------------------------
  // Converting
  // -------------------------------------------------------------------------

  goBtn.addEventListener('click', async () => {
    errorBox(panel, null);
    clearResult();
    const queue = readyItems();
    if (!queue.length) return;

    // Settings are read once, up front: changing the format select halfway
    // through a queue must not leave half the batch in the other container.
    const containerId = formatSel.value;
    const spec = CONTAINERS[containerId];
    const plans = queue.map((it) => planFor(it.probe));
    const dropAudio = muteBox.checked;
    const outputs = [];
    const warnings = [];
    const takenNames = new Set();
    let bytesBefore = 0;
    let stopped = false;

    busy = true;
    goBtn.disabled = true;
    clearBtn.disabled = true;
    renderList();
    const signal = job.start(`File 1 of ${queue.length} — 0%`);

    // One file at a time: two 1 GB conversions running side by side is a tab
    // crash on a student laptop, and the queue is not any faster in parallel.
    for (let i = 0; i < queue.length; i++) {
      if (job.canceled) { stopped = true; break; }
      const { file, probe } = queue[i];
      const plan = plans[i];
      const step = (pct) => `File ${i + 1} of ${queue.length} — ${pct}%`;
      job.update(i / queue.length, step(0));

      if (plan.encode && !probe.video.decodable) {
        // A copy never opens the video, but a re-encode has to decode every
        // frame first — so this only blocks the files that need it, and it says
        // which setting to put back rather than just failing.
        const name = CODEC_NAMES[probe.video.codec] ?? probe.video.codec ?? 'that codec';
        warnings.push(`${file.name} was skipped — this browser cannot decode ${name} video, so it cannot be re-encoded. Set Resolution and Frame rate back to "Keep original" and choose MKV, which can carry the video across untouched.`);
      } else {
        try {
          const result = await convertMedia({
            file,
            container: containerId,
            // Every one of these options makes Mediabunny re-encode, so each is
            // left out unless it is genuinely needed. With none of them set the
            // packets are copied straight across: same pixels, no waiting.
            video: {
              ...(plan.scaled ? { width: plan.width, height: plan.height, fit: 'contain' } : {}),
              ...(plan.frameRate ? { frameRate: plan.frameRate } : {}),
              ...(plan.encode
                ? { codec: await pickVideoCodec(containerId, { width: plan.width, height: plan.height }) }
                : {}),
            },
            // Left undefined whenever the track can stay as it is: Mediabunny
            // then copies the encoded audio across untouched. A codec is named
            // only when the source one would leave the file silent in the
            // players students actually use — and naming the codec the track
            // already uses would still copy, so nothing is re-encoded twice.
            audio: dropAudio || !probe.hasAudio
              ? { discard: true }
              : plan.recodedAudioFrom
                ? { codec: await pickAudioCodec(containerId, { numberOfChannels: probe.audio.channels, sampleRate: probe.audio.sampleRate }) }
                : undefined,
            onProgress: (fraction) => {
              job.update((i + fraction) / queue.length, step(Math.round(fraction * 100)));
            },
            signal,
          });

          outputs.push({ name: outputName(file, result.ext, takenNames), blob: result.blob });
          bytesBefore += file.size;
          warnings.push(...result.warnings.map((w) => `${file.name} — ${w}`));
        } catch (err) {
          // A cancel ends the whole queue; one bad file only costs that file.
          if (isCanceled(err)) { stopped = true; break; }
          warnings.push(`${file.name} could not be converted — ${err.message}`);
        }
      }

      // Hand the tab back between files so the progress bar repaints and the
      // finished file's buffers can be collected before the next one is read.
      await yieldToBrowser();
    }

    job.stop();
    busy = false;
    clearBtn.disabled = false;
    renderList();
    updatePlan();

    if (!outputs.length) {
      if (stopped) toast('Conversion canceled');
      else errorBox(panel, warnings[0] ?? `Nothing could be written to a ${spec.label} file.`);
      return;
    }
    if (stopped) toast('Stopped — the finished files are below');
    showResult({ outputs, bytesBefore, warnings, spec, stopped });
  });

  /**
   * `clip.mov` → `clip.mp4`. When the extension does not change (a resize that
   * stays MP4, say) the output would otherwise carry the original's exact name,
   * which is a good way to lose the original.
   */
  function outputName(file, ext, taken) {
    let name = `${stem(file.name)}.${ext}`;
    if (name === file.name) name = `${stem(file.name)}-converted.${ext}`;
    if (taken.has(name)) {
      // clip.mov and clip.mkv both want to be clip.mp4, and the ZIP would
      // quietly keep only one of them.
      const base = stem(name);
      let n = 2;
      while (taken.has(`${base}-${n}.${ext}`)) n++;
      name = `${base}-${n}.${ext}`;
    }
    taken.add(name);
    return name;
  }

  function clearResult() {
    resultPreview?.destroy();
    resultPreview = null;
    resultsHost.innerHTML = '';
  }

  function showResult({ outputs, bytesBefore, warnings, spec, stopped }) {
    const bytesAfter = outputs.reduce((sum, o) => sum + o.blob.size, 0);
    const one = outputs.length === 1;

    // A single output is worth previewing — it is the quickest way to see that
    // the file really does play now.
    let preview;
    if (one) {
      resultPreview = mediaPreview(new File([outputs[0].blob], outputs[0].name, { type: outputs[0].blob.type }), { kind: 'video' });
      preview = resultPreview.node;
    }

    resultsHost.appendChild(resultCard({
      heading: stopped ? `✅ Stopped — ${outputs.length} finished` : `✅ Done — ${one ? `your ${spec.label} is ready` : `${outputs.length} ${spec.label} files`}`,
      message: one
        ? 'Play it here before you hand it in — if it opens in this player, it opens on your classmate\'s phone.'
        : 'Grab the ZIP and open one of them to check — if it plays, they all will.',
      stats: [
        [String(outputs.length), one ? 'File converted' : 'Files converted'],
        [formatBytes(bytesBefore), 'Before'],
        [formatBytes(bytesAfter), 'After'],
      ],
      outputs,
      warnings,
      zipName: 'unilab-converted-video.zip',
      preview,
    }));
  }

  // Leaving the page mid-queue must not leave a converted video's blob URL
  // pinned in memory — on a phone that is the whole file, still resident.
  window.addEventListener('hashchange', clearResult, { once: true });

  panel.append(zone, list, controls, job.root);
  container.append(panel, resultsHost);
  container.appendChild(el(`
    <p class="note">Most iPhone .MOV files are already H.264 inside, so turning them into MP4
    only swaps the wrapper — a second per file, and the video looks identical. Change the
    resolution or frame rate only when you actually need to; that is what turns a one-second
    job into a long one. Nothing is uploaded — it all runs on your device.</p>
  `));
}
