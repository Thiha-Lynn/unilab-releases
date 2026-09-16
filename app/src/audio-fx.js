// The audio DSP foundation — decode, analyse, clean, and re-encode, all on-device.
//
// Adobe's Podcast Enhance does this with a server-side neural model; UniLab's
// version is classical signal processing that runs entirely in this tab. That is
// an honest trade: spectral gating cannot reconstruct a voice drowned by a
// passing truck, but for the noise students actually record over — fan hum,
// aircon hiss, mains buzz, dorm-corridor rumble — it removes the right thing and
// nothing leaves the device.
//
// Everything here works on AudioBuffers between decode and encode. Encoding
// reuses the existing mediabunny pipeline (see encodeBuffer): a WAV is built
// here, then handed to convertMedia exactly as if the user had chosen a WAV
// file, so MP3/M4A export goes through the same battle-tested path every other
// audio tool uses.

import { convertMedia, ensureMp3Encoder } from './media-utils.js';

// ---------------------------------------------------------------------------
// Decode / channels
// ---------------------------------------------------------------------------

/** Decode any browser-supported audio file to an AudioBuffer. */
export async function decodeAudio(file) {
  const bytes = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 48000);
  try {
    return await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error(`Could not read ${file.name} as audio. If it plays elsewhere, convert it to MP3 or WAV first.`);
  }
}

export function channelData(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

/** Build an AudioBuffer from Float32Array channels. */
export function buffersFrom(channels, sampleRate) {
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const buffer = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((ch, i) => buffer.copyToChannel(ch, i));
  return buffer;
}

export function toMonoData(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buffer.numberOfChannels;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Offline graph rendering — for everything the platform already does well
// (biquad EQ, notch filters, the compressor), build a node graph and render it.
// ---------------------------------------------------------------------------

/**
 * Render `buffer` through a node chain. `build(ctx, input)` must return the
 * last node of the chain (it is connected to the destination here).
 */
export async function renderGraph(buffer, build) {
  const ctx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const tail = build(ctx, src) ?? src;
  tail.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

/** A chain of peaking/shelf biquads from [{type, frequency, gain, Q}] specs. */
export function eqChain(ctx, input, bands) {
  let node = input;
  for (const b of bands) {
    const f = ctx.createBiquadFilter();
    f.type = b.type ?? 'peaking';
    f.frequency.value = b.frequency;
    if (b.gain !== undefined) f.gain.value = b.gain;
    f.Q.value = b.Q ?? 1.0;
    node.connect(f);
    node = f;
  }
  return node;
}

/**
 * Notches for mains hum: the fundamental plus harmonics. 50 Hz covers
 * Thailand/Myanmar (and most of the world); 60 Hz the Americas.
 */
export function humNotches(fundamental, harmonics = 4) {
  const bands = [];
  for (let h = 1; h <= harmonics; h++) {
    bands.push({ type: 'notch', frequency: fundamental * h, Q: 30 });
  }
  return bands;
}

export function speechCompressor(ctx, input, { threshold = -24, ratio = 3, attack = 0.003, release = 0.25, knee = 24 } = {}) {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = threshold;
  comp.ratio.value = ratio;
  comp.attack.value = attack;
  comp.release.value = release;
  comp.knee.value = knee;
  input.connect(comp);
  return comp;
}

// ---------------------------------------------------------------------------
// FFT — radix-2, in-place, real enough for STFT work.
// ---------------------------------------------------------------------------

export function fft(re, im, inverse = false) {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

// ---------------------------------------------------------------------------
// Spectral noise gating — the heart of "remove the hiss".
//
// STFT the signal, estimate the noise floor per frequency bin (from an explicit
// noise-only region if given, otherwise from the quietest 10% of frames — which
// in any lecture recording is the gaps between sentences), then attenuate every
// bin that does not rise above its own floor by a margin. Temporal and spectral
// smoothing of the gain mask is what separates this from the "musical noise"
// warble of naive spectral subtraction.
// ---------------------------------------------------------------------------

const FRAME = 2048;
const HOP = FRAME / 4;

/**
 * Reduce steady background noise on every channel.
 * strength 0..1 (how far gated bins are pushed down: 1 ≈ −30 dB).
 * noiseRegion: optional {start, end} seconds of noise-only audio to learn from.
 * Yields between frames via onProgress-driven chunks; caller passes signal for cancel.
 */
export async function spectralDenoise(buffer, { strength = 0.7, noiseRegion = null, signal, onProgress } = {}) {
  const sr = buffer.sampleRate;
  const window = hannWindow(FRAME);
  const bins = FRAME / 2 + 1;
  const floorGain = Math.pow(10, (-30 * strength) / 20);   // how deep gated bins drop
  const overThreshold = 2.0;                                // bin must be 2× its floor to pass untouched

  const outChannels = [];
  const re = new Float32Array(FRAME), im = new Float32Array(FRAME);
  const spectrumOf = (x, off) => {
    for (let i = 0; i < FRAME; i++) { re[i] = (x[off + i] ?? 0) * window[i]; im[i] = 0; }
    fft(re, im);
  };
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const x = buffer.getChannelData(c);
    const frames = Math.max(1, Math.floor((x.length - FRAME) / HOP) + 1);

    // ---- pass 1: per-frame energy only. Storing every frame's whole spectrum
    // reads nicer, but at 60 minutes of audio that array is over a gigabyte and
    // the tab dies on exactly the lecture recordings this tool exists for.
    // Energy is enough to pick the quiet frames; their spectra are recomputed
    // below, which costs ~10% extra FFTs and O(frames) memory instead. ----
    const frameEnergy = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      if (signal?.aborted) throw new Error('canceled');
      const off = f * HOP;
      let energy = 0;
      for (let i = 0; i < FRAME; i++) { const v = (x[off + i] ?? 0) * window[i]; energy += v * v; }
      frameEnergy[f] = energy;
      if ((f & 255) === 0) { onProgress?.((c + (f / frames) * 0.15) / buffer.numberOfChannels); await breathe(); }
    }

    // ---- noise profile from the chosen frames' (re-computed) spectra ----
    const profile = new Float32Array(bins);
    let profileFrames;
    if (noiseRegion) {
      const f0 = Math.max(0, Math.floor((noiseRegion.start * sr) / HOP));
      const f1 = Math.min(frames - 1, Math.ceil((noiseRegion.end * sr) / HOP));
      profileFrames = [];
      for (let f = f0; f <= f1; f++) profileFrames.push(f);
    } else {
      // the quietest 10% of frames stand in for "just the room"
      const order = [...frameEnergy.keys()].sort((a, b) => frameEnergy[a] - frameEnergy[b]);
      profileFrames = order.slice(0, Math.max(1, Math.floor(frames * 0.1)));
    }
    for (const [k, f] of profileFrames.entries()) {
      if (signal?.aborted) throw new Error('canceled');
      spectrumOf(x, f * HOP);
      for (let b = 0; b < bins; b++) profile[b] += Math.hypot(re[b], im[b]) / profileFrames.length;
      if ((k & 127) === 0) { onProgress?.((c + 0.15 + (k / profileFrames.length) * 0.1) / buffer.numberOfChannels); await breathe(); }
    }

    // ---- pass 2: gain mask, smoothed, then overlap-add resynthesis ----
    const out = new Float32Array(x.length);
    const norm = new Float32Array(x.length);
    const prevGain = new Float32Array(bins).fill(1);
    const gains = new Float32Array(bins);
    for (let f = 0; f < frames; f++) {
      if (signal?.aborted) throw new Error('canceled');
      const off = f * HOP;
      spectrumOf(x, off);

      for (let b = 0; b < bins; b++) {
        const m = Math.hypot(re[b], im[b]);
        const gate = m > profile[b] * overThreshold ? 1 : floorGain;
        // temporal smoothing: fast to open (speech onsets stay crisp), slow to
        // close (word tails do not get chopped)
        gains[b] = gate > prevGain[b] ? gate : prevGain[b] * 0.6 + gate * 0.4;
      }
      // spectral smoothing across neighbouring bins kills isolated flickers
      for (let b = 1; b < bins - 1; b++) {
        gains[b] = (gains[b - 1] + gains[b] * 2 + gains[b + 1]) / 4;
      }
      prevGain.set(gains);

      for (let b = 0; b < bins; b++) {
        const g = gains[b];
        re[b] *= g; im[b] *= g;
        if (b > 0 && b < bins - 1) {           // mirror for the negative bins
          re[FRAME - b] *= g; im[FRAME - b] *= g;
        }
      }
      fft(re, im, true);
      for (let i = 0; i < FRAME; i++) {
        const idx = off + i;
        if (idx >= out.length) break;
        out[idx] += re[i] * window[i];
        norm[idx] += window[i] * window[i];
      }
      if ((f & 63) === 0) { onProgress?.((c + 0.25 + (f / frames) * 0.75) / buffer.numberOfChannels); await breathe(); }
    }
    // Overlap-add normalisation. At the very edges only a sliver of one window
    // covers a sample, so dividing by the tiny weight amplifies it into a spike
    // (measured: a 0.45-peak signal came back at 1.66). Where coverage is thin,
    // fall back to the original sample instead of amplifying the residue.
    for (let i = 0; i < out.length; i++) {
      if (norm[i] > 0.5) out[i] /= norm[i];
      else out[i] = x[i];
    }
    outChannels.push(out);
  }
  return buffersFrom(outChannels, sr);
}

// ---------------------------------------------------------------------------
// Loudness — a practical LUFS approximation: K-weighting (shelf + high-pass)
// then gated mean-square over 400 ms blocks. Within ~1 LU of the real thing on
// speech, which is all a "make it as loud as a podcast" button needs.
// ---------------------------------------------------------------------------

export async function measureLoudness(buffer) {
  const weighted = await renderGraph(buffer, (ctx, src) =>
    eqChain(ctx, src, [
      { type: 'highshelf', frequency: 1500, gain: 4 },
      { type: 'highpass', frequency: 60, Q: 0.5 },
    ]));
  const mono = toMonoData(weighted);
  const block = Math.floor(weighted.sampleRate * 0.4);
  const hop = Math.floor(block * 0.25);
  const blocks = [];
  for (let off = 0; off + block <= mono.length; off += hop) {
    let sum = 0;
    for (let i = off; i < off + block; i++) sum += mono[i] * mono[i];
    blocks.push(sum / block);
  }
  if (!blocks.length) return -70;
  // absolute gate at −70 LUFS, then relative gate 10 LU under the ungated mean
  const toLufs = (ms) => -0.691 + 10 * Math.log10(ms + 1e-12);
  let active = blocks.filter((ms) => toLufs(ms) > -70);
  if (!active.length) return -70;
  const mean1 = toLufs(active.reduce((a, b) => a + b, 0) / active.length);
  active = active.filter((ms) => toLufs(ms) > mean1 - 10);
  if (!active.length) return mean1;
  return toLufs(active.reduce((a, b) => a + b, 0) / active.length);
}

export function peakOf(buffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  }
  return peak;
}

/** Gain the whole buffer to a target LUFS, never letting the peak clip past −1 dBFS. */
export async function normalizeLoudness(buffer, targetLufs = -16) {
  const current = await measureLoudness(buffer);
  let gain = Math.pow(10, (targetLufs - current) / 20);
  const peak = peakOf(buffer);
  const ceiling = Math.pow(10, -1 / 20);      // −1 dBFS true-ish peak headroom
  if (peak * gain > ceiling) gain = ceiling / peak;
  const channels = channelData(buffer).map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * gain;
    return out;
  });
  return { buffer: buffersFrom(channels, buffer.sampleRate), appliedDb: 20 * Math.log10(gain), fromLufs: current };
}

// ---------------------------------------------------------------------------
// Silence — find it, cut it, or shorten it.
// ---------------------------------------------------------------------------

/** Regions (seconds) quieter than thresholdDb for at least minLen seconds. */
export function detectSilences(buffer, { thresholdDb = -40, minLen = 1.0 } = {}) {
  const mono = toMonoData(buffer);
  const sr = buffer.sampleRate;
  const win = Math.floor(sr * 0.02);
  // RMS per window, not peak: a recording with audible hiss never has a quiet
  // PEAK, but its between-sentence windows still sit well below speech in RMS —
  // which is the thing "silence" actually means in a lecture recording.
  const threshold = Math.pow(10, thresholdDb / 10);   // power domain
  const regions = [];
  let start = null;
  for (let off = 0; off < mono.length; off += win) {
    let sum = 0;
    const end = Math.min(off + win, mono.length);
    for (let i = off; i < end; i++) sum += mono[i] * mono[i];
    const quiet = sum / Math.max(1, end - off) < threshold;
    if (quiet && start === null) start = off / sr;
    if (!quiet && start !== null) {
      if (off / sr - start >= minLen) regions.push({ start, end: off / sr });
      start = null;
    }
  }
  if (start !== null && mono.length / sr - start >= minLen) regions.push({ start, end: mono.length / sr });
  return regions;
}

/**
 * A sensible silence threshold for THIS recording: the 10th-percentile window
 * RMS (≈ the room's own floor) plus 10 dB. Saves the user from having to know
 * what a decibel is before cutting the dead air out of a lecture.
 */
export function suggestSilenceThreshold(buffer) {
  const mono = toMonoData(buffer);
  const sr = buffer.sampleRate;
  const win = Math.floor(sr * 0.05);
  const levels = [];
  for (let off = 0; off + win <= mono.length; off += win) {
    let sum = 0;
    for (let i = off; i < off + win; i++) sum += mono[i] * mono[i];
    levels.push(10 * Math.log10(sum / win + 1e-12));
  }
  if (!levels.length) return -40;
  levels.sort((a, b) => a - b);
  const floor = levels[Math.floor(levels.length * 0.1)];
  return Math.min(-25, Math.max(-60, floor + 10));
}

/**
 * Rebuild the buffer with each silence either removed or shortened to keepGap
 * seconds, crossfading 10 ms at every joint so cuts never click.
 */
export function cutSilences(buffer, silences, { keepGap = 0.3 } = {}) {
  const sr = buffer.sampleRate;
  const fade = Math.floor(sr * 0.01);
  const keep = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) keep.push([cursor, s.start]);
    const gap = Math.min(keepGap, s.end - s.start);
    if (gap > 0) keep.push([s.start, s.start + gap]);
    cursor = s.end;
  }
  const total = buffer.length / sr;
  if (cursor < total) keep.push([cursor, total]);

  const outLen = keep.reduce((n, [a, b]) => n + Math.floor((b - a) * sr), 0);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const x = buffer.getChannelData(c);
    const out = new Float32Array(outLen);
    let w = 0;
    for (const [a, b] of keep) {
      const i0 = Math.floor(a * sr), i1 = Math.floor(b * sr);
      for (let i = i0; i < i1 && w < outLen; i++, w++) {
        let v = x[i];
        const intoSeg = i - i0, fromEnd = i1 - i;
        if (intoSeg < fade && w > fade) v *= intoSeg / fade;          // fade in at a joint
        if (fromEnd < fade && i1 < x.length) v *= fromEnd / fade;     // fade out into a cut
        out[w] = v;
      }
    }
    channels.push(out);
  }
  return buffersFrom(channels, sr);
}

// ---------------------------------------------------------------------------
// Time stretch — WSOLA. Changes speed without changing pitch, which is what
// "listen to the lecture at 1.5×, keep the lecturer human" needs.
// ---------------------------------------------------------------------------

export async function timeStretch(buffer, rate, { signal, onProgress } = {}) {
  if (Math.abs(rate - 1) < 1e-3) return buffer;
  const sr = buffer.sampleRate;
  const seg = Math.floor(sr * 0.08);          // 80 ms grains suit speech
  const overlap = Math.floor(seg / 2);
  const seek = Math.floor(sr * 0.012);        // ±12 ms search for the best join
  const flat = hannWindow(overlap * 2);

  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const x = buffer.getChannelData(c);
    const outLen = Math.floor(x.length / rate);
    const out = new Float32Array(outLen + seg);
    // first grain verbatim
    for (let i = 0; i < Math.min(seg, x.length); i++) out[i] = x[i];
    let inPos = Math.floor(seg * rate);
    let outPos = seg;
    let iter = 0;
    while (outPos < outLen && inPos + seg + seek < x.length) {
      if (signal?.aborted) throw new Error('canceled');
      // search the small window around inPos for the offset whose start best
      // matches what we already wrote (maximum cross-correlation)
      const tailStart = outPos - overlap;
      let best = 0, bestScore = -Infinity;
      for (let d = -seek; d <= seek; d += 8) {
        let score = 0;
        const base = inPos + d;
        if (base < 0) continue;
        for (let i = 0; i < overlap; i += 4) score += out[tailStart + i] * x[base + i];
        if (score > bestScore) { bestScore = score; best = d; }
      }
      const src = inPos + best;
      // crossfade the overlap, then copy the rest of the grain
      for (let i = 0; i < overlap; i++) {
        const w = flat[i];
        out[tailStart + i] = out[tailStart + i] * (1 - w) + x[src + i] * w;
      }
      const copyLen = Math.min(seg - overlap, x.length - src - overlap, out.length - outPos);
      for (let i = 0; i < copyLen; i++) out[outPos + i] = x[src + overlap + i];
      outPos += seg - overlap;
      inPos += Math.floor((seg - overlap) * rate);
      if ((iter++ & 31) === 0) { onProgress?.((c + outPos / outLen) / buffer.numberOfChannels); await breathe(); }
    }
    channels.push(out.slice(0, outLen));
  }
  return buffersFrom(channels, sr);
}

// ---------------------------------------------------------------------------
// Encode — WAV here; MP3/M4A/OGG by handing the WAV to the existing pipeline.
// ---------------------------------------------------------------------------

export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, sr = buffer.sampleRate, n = buffer.length;
  const bytes = 44 + n * ch * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, ch, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * ch * 2, true); view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, n * ch * 2, true);
  let off = 44;
  const chans = channelData(buffer);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

/**
 * Encode a processed buffer to wav/mp3/m4a/ogg. Non-WAV goes through the same
 * mediabunny path the recorder tools use, so behaviour and quality match.
 */
export async function encodeBuffer(buffer, { format = 'mp3', kbps = 128, name = 'audio', onProgress, signal } = {}) {
  const wav = encodeWav(buffer);
  if (format === 'wav') return { blob: wav, ext: 'wav' };
  if (format === 'mp3') await ensureMp3Encoder();
  const { blob, ext } = await convertMedia({
    file: new File([wav], `${name}.wav`, { type: 'audio/wav' }),
    container: format,
    audio: { bitrate: kbps * 1000 },
    onProgress,
    signal,
  });
  return { blob, ext };
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

/** Waveform peaks for drawing: `buckets` pairs of [min, max] in −1..1. */
export function waveformPeaks(buffer, buckets = 600) {
  const mono = toMonoData(buffer);
  const per = Math.max(1, Math.floor(mono.length / buckets));
  const peaks = [];
  for (let b = 0; b < buckets; b++) {
    let lo = 0, hi = 0;
    const off = b * per, end = Math.min(off + per, mono.length);
    for (let i = off; i < end; i++) { if (mono[i] < lo) lo = mono[i]; if (mono[i] > hi) hi = mono[i]; }
    peaks.push([lo, hi]);
  }
  return peaks;
}

export function drawWaveform(canvas, peaks, { color = '#8484e8', background = 'transparent' } = {}) {
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  g.clearRect(0, 0, w, h);
  if (background !== 'transparent') { g.fillStyle = background; g.fillRect(0, 0, w, h); }
  g.fillStyle = color;
  const mid = h / 2;
  const step = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const [lo, hi] = peaks[i];
    const y0 = mid + lo * mid, y1 = mid + hi * mid;
    g.fillRect(i * step, y0, Math.max(1, step - 0.5), Math.max(1, y1 - y0));
  }
}

/** RMS in dBFS over an optional region — for before/after "the hiss dropped 14 dB" claims. */
export function rmsDb(buffer, { start = 0, end = buffer.length / buffer.sampleRate } = {}) {
  const mono = toMonoData(buffer);
  const sr = buffer.sampleRate;
  const i0 = Math.max(0, Math.floor(start * sr)), i1 = Math.min(mono.length, Math.floor(end * sr));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += mono[i] * mono[i];
  const n = Math.max(1, i1 - i0);
  return 10 * Math.log10(sum / n + 1e-12);
}

// Yield on a time budget. The yield primitive is a MessageChannel round-trip,
// not setTimeout(0): a chain of nested zero-timeouts in a tab that has been
// hidden for a while gets intensively throttled by Chrome to ONE PER MINUTE,
// which froze a 200 ms audio job at 52% for as long as the tab stayed hidden
// (observed, not theorised). Message-port tasks are exempt from timer
// throttling, so heavy processing keeps running when the student switches to
// another tab — which is exactly when they let a long job run.
const yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
let lastYield = 0;
export async function breathe(budgetMs = 24) {
  const now = performance.now();
  if (now - lastYield < budgetMs) return;
  if (yieldChannel) {
    await new Promise((r) => {
      yieldChannel.port1.onmessage = r;
      yieldChannel.port2.postMessage(0);
    });
  } else {
    await new Promise((r) => setTimeout(r, 0));
  }
  lastYield = performance.now();
}
