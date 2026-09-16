// Shared media engine for UniLab's video & audio tools.
//
// Everything here runs on Mediabunny (https://mediabunny.dev), a pure-JS media
// toolkit built on the browser's WebCodecs API. That choice is deliberate:
// ffmpeg.wasm would mean shipping a ~31 MB WebAssembly build and decoding on the
// CPU, while WebCodecs uses the same hardware decoder the video player uses. The
// privacy promise is identical either way — no byte of the file ever leaves the
// device — but this one stays fast enough to use on a student laptop or phone.

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  Quality,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';

// ---------------------------------------------------------------------------
// File input hints
//
// Mediabunny reads MP4/MOV/M4V, WebM/MKV, MP3, WAV, Ogg/Opus, AAC/ADTS, FLAC and
// MPEG-TS. It does not read AVI or WMV, so those are left out of the accept
// lists on purpose — better to never offer a file we'd have to reject later.
// ---------------------------------------------------------------------------
export const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.m4v,.mov,.webm,.mkv,.ts';
export const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac';
export const MEDIA_ACCEPT = `${VIDEO_ACCEPT},${AUDIO_ACCEPT}`;

// ---------------------------------------------------------------------------
// Output containers
// ---------------------------------------------------------------------------
export const CONTAINERS = {
  mp4: {
    label: 'MP4', ext: 'mp4', mime: 'video/mp4', kind: 'video',
    note: 'Plays everywhere — LMS, LINE, phones, PowerPoint.',
    // fastStart puts the index at the front of the file so players can start
    // before the whole download finishes, which is what "streamable" means.
    make: () => new Mp4OutputFormat({ fastStart: 'in-memory' }),
  },
  webm: {
    label: 'WebM', ext: 'webm', mime: 'video/webm', kind: 'video',
    note: 'Smaller files, best for the web. Older phones may not play it.',
    make: () => new WebMOutputFormat(),
  },
  mov: {
    label: 'MOV', ext: 'mov', mime: 'video/quicktime', kind: 'video',
    note: 'QuickTime — the format iPhones and Macs record in.',
    make: () => new MovOutputFormat({ fastStart: 'in-memory' }),
  },
  mkv: {
    label: 'MKV', ext: 'mkv', mime: 'video/x-matroska', kind: 'video',
    note: 'Flexible container, good for archiving.',
    make: () => new MkvOutputFormat(),
  },
  mp3: {
    label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', kind: 'audio',
    note: 'The safe choice — every player and phone opens it.',
    make: () => new Mp3OutputFormat(),
  },
  m4a: {
    label: 'M4A (AAC)', ext: 'm4a', mime: 'audio/mp4', kind: 'audio',
    note: 'Better quality than MP3 at the same size. Apple‑friendly.',
    make: () => new Mp4OutputFormat({ fastStart: 'in-memory' }),
  },
  wav: {
    label: 'WAV', ext: 'wav', mime: 'audio/wav', kind: 'audio',
    note: 'Uncompressed — big files, but no quality loss. Good for editing.',
    make: () => new WavOutputFormat(),
  },
  ogg: {
    label: 'OGG (Opus)', ext: 'ogg', mime: 'audio/ogg', kind: 'audio',
    note: 'Smallest files for voice recordings and lectures.',
    make: () => new OggOutputFormat(),
  },
};

/** Default audio codec for each container, so callers rarely have to think about it. */
export const CONTAINER_AUDIO_CODEC = {
  mp4: 'aac', mov: 'aac', mkv: 'aac', m4a: 'aac',
  webm: 'opus', ogg: 'opus',
  mp3: 'mp3',
  wav: 'pcm-s16',
};

/** Default video codec for each video container. */
export const CONTAINER_VIDEO_CODEC = {
  mp4: 'avc', mov: 'avc', mkv: 'avc', webm: 'vp9',
};

/**
 * Codec preference per container, most-compatible first. H.264/AAC in an MP4 is
 * still the only combination that plays on literally every phone, projector and
 * LMS video player a student will meet, so it leads the list.
 */
const VIDEO_CODEC_ORDER = {
  mp4: ['avc', 'hevc', 'vp9', 'av1'],
  mov: ['avc', 'hevc'],
  mkv: ['avc', 'vp9', 'av1', 'vp8'],
  webm: ['vp9', 'vp8', 'av1'],
};
const AUDIO_CODEC_ORDER = {
  mp4: ['aac', 'opus'], mov: ['aac'], m4a: ['aac'], mkv: ['aac', 'opus'],
  webm: ['opus', 'vorbis'], ogg: ['opus', 'vorbis'], mp3: ['mp3'], wav: ['pcm-s16'],
};

/**
 * Picks the best codec this browser can actually encode for a container.
 * Returns `undefined` when none is available, which tells Mediabunny to choose.
 */
export async function pickVideoCodec(container, { width, height, bitrate } = {}) {
  const order = VIDEO_CODEC_ORDER[container];
  if (!order) return undefined;
  const codec = await getFirstEncodableVideoCodec(order, {
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(bitrate ? { quality: quality(bitrate) } : {}),
  });
  return codec ?? undefined;
}

/** Same idea for audio. Registers the MP3 encoder first when MP3 is in play. */
export async function pickAudioCodec(container, { numberOfChannels, sampleRate } = {}) {
  const order = AUDIO_CODEC_ORDER[container];
  if (!order) return undefined;
  if (order.includes('mp3')) await ensureMp3Encoder();
  const codec = await getFirstEncodableAudioCodec(order, {
    ...(numberOfChannels ? { numberOfChannels } : {}),
    ...(sampleRate ? { sampleRate } : {}),
  });
  return codec ?? CONTAINER_AUDIO_CODEC[container];
}

// ---------------------------------------------------------------------------
// Capability checks
// ---------------------------------------------------------------------------

/** True when this browser exposes the WebCodecs API the media tools are built on. */
export function hasWebCodecs() {
  return typeof window !== 'undefined'
    && typeof window.VideoDecoder === 'function'
    && typeof window.AudioDecoder === 'function';
}

/**
 * Drops a friendly "your browser can't do this" panel into `container` and
 * returns false when WebCodecs is missing. Every media tool calls this first.
 */
export function requireWebCodecs(container) {
  if (hasWebCodecs()) return true;
  const box = document.createElement('div');
  box.className = 'panel media-unsupported';
  box.innerHTML = `
    <h3>This tool needs a newer browser</h3>
    <p>UniLab edits video and audio using <b>WebCodecs</b>, the browser feature that
       lets a page use your device's own video hardware — that's how the file can be
       processed without ever being uploaded.</p>
    <p>Your browser doesn't support it yet. Chrome, Edge, Opera, Firefox 130+ and
       Safari 16.4+ (iOS 16.4+) all do. Everything else in UniLab still works here.</p>
  `;
  container.appendChild(box);
  return false;
}

let mp3EncoderReady = null;
/**
 * Browsers ship an MP3 *decoder* but almost never an MP3 *encoder*, so writing
 * MP3 needs Mediabunny's LAME extension. It's ~200 KB of WASM, loaded only the
 * first time somebody actually asks for an MP3.
 */
export async function ensureMp3Encoder() {
  if (!mp3EncoderReady) {
    mp3EncoderReady = (async () => {
      if (await canEncodeAudio('mp3')) return;
      const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
      registerMp3Encoder();
    })();
  }
  return mp3EncoderReady;
}

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

/** Opens a file for reading. Callers must `input.dispose()` when finished. */
export function openMedia(file) {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

/**
 * Reads everything the tools need to describe a file: duration, resolution,
 * codecs, channel layout. Cheap — it reads container metadata, not the media.
 *
 * Returns `{ duration, video, audio, mimeType, hasVideo, hasAudio }` where
 * `video` is `{ width, height, codec, rotation, frameRate }` or null.
 */
export async function probeMedia(file, { frameRate = false } = {}) {
  const input = openMedia(file);
  try {
    if (!(await input.canRead())) {
      throw new Error(`${file.name} isn't a media file UniLab can read. Try MP4, MOV, WebM, MKV, MP3, M4A, WAV or OGG.`);
    }
    const [videoTrack, audioTrack, mimeType] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
      input.getMimeType().catch(() => file.type || ''),
    ]);
    if (!videoTrack && !audioTrack) {
      throw new Error(`${file.name} has no video or audio track UniLab can use.`);
    }

    let duration = await input.getDurationFromMetadata().catch(() => null);
    if (!Number.isFinite(duration) || duration <= 0) duration = await input.computeDuration();

    let video = null;
    if (videoTrack) {
      const [width, height, codec, rotation, decodable, bitrate] = await Promise.all([
        videoTrack.getDisplayWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getCodec(),
        videoTrack.getRotation(),
        videoTrack.canDecode(),
        estimateBitrate(videoTrack),
      ]);
      video = { width, height, codec, rotation, decodable, bitrate, frameRate: null };
      if (frameRate) {
        // Sampling a couple hundred packets is enough for a solid guess and
        // avoids walking a 500 MB file just to draw "30 fps" on screen.
        const metrics = await videoTrack.computeFrameRateMetrics({ targetPacketCount: 200 }).catch(() => null);
        video.frameRate = metrics?.bestGuessFrameRate ?? null;
      }
    }

    let audio = null;
    if (audioTrack) {
      const [channels, sampleRate, codec, decodable, bitrate] = await Promise.all([
        audioTrack.getNumberOfChannels(),
        audioTrack.getSampleRate(),
        audioTrack.getCodec(),
        audioTrack.canDecode(),
        estimateBitrate(audioTrack),
      ]);
      audio = { channels, sampleRate, codec, decodable, bitrate };
    }

    return { duration, video, audio, mimeType, hasVideo: !!video, hasAudio: !!audio, size: file.size, name: file.name };
  } finally {
    input.dispose();
  }
}

/**
 * Roughly what a track is already using, in bits per second. MP4 and MOV almost
 * never declare a bitrate, so fall back to sampling a couple of hundred packets
 * — enough for a good estimate, cheap even on a two-hour recording.
 */
async function estimateBitrate(track) {
  try {
    const declared = await track.getBitrate();
    if (declared) return declared;
    const stats = await track.computePacketStats(200);
    return stats?.averageBitrate || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Converting a file
// ---------------------------------------------------------------------------

/**
 * Mirrors Mediabunny's own "can I copy these packets straight across?" test
 * (see conversion.ts). We need to know the answer *before* the conversion runs,
 * because of a sharp edge: naming a quality forces a re-encode. So we may only
 * name one for a track that was going to be re-encoded anyway.
 */
async function willCopyVideo(track, opts, format, startTimestamp) {
  if (!track || opts?.discard) return true;
  if (opts?.forceTranscode || opts?.frameRate || opts?.crop || opts?.process) return false;
  if (opts?.keyFrameInterval !== undefined || opts?.quality !== undefined || opts?.bitrate !== undefined) return false;
  if (await track.getFirstTimestamp() < startTimestamp) return false;

  const sourceCodec = await track.getCodec();
  if (!sourceCodec || !format.getSupportedVideoCodecs().includes(sourceCodec)) return false;
  if (opts?.codec && opts.codec !== sourceCodec) return false;

  const rotation = (await track.getRotation()) + (opts?.rotate ?? 0);
  const canUseRotationMetadata = format.supportsVideoRotationMetadata && (opts?.allowRotationMetadata ?? true);
  if (rotation % 360 !== 0 && !canUseRotationMetadata) return false;

  // Asking for the size the video already is doesn't count as a resize.
  if (opts?.width !== undefined || opts?.height !== undefined) {
    const [w, h] = rotation % 180 === 0
      ? [await track.getSquarePixelWidth(), await track.getSquarePixelHeight()]
      : [await track.getSquarePixelHeight(), await track.getSquarePixelWidth()];
    if (opts.width !== undefined && evenSize(opts.width) !== evenSize(w)) return false;
    if (opts.height !== undefined && evenSize(opts.height) !== evenSize(h)) return false;
  }
  return true;
}

/** The same test for audio. */
async function willCopyAudio(track, opts, format, startTimestamp) {
  if (!track || opts?.discard) return true;
  if (opts?.forceTranscode || opts?.process) return false;
  if (opts?.quality !== undefined || opts?.bitrate !== undefined || opts?.sampleFormat !== undefined) return false;

  const first = await track.getFirstTimestamp();
  // AAC carries a short priming section, which lands its first sample just
  // before zero — so almost every MP4 on a phone fails this test and has its
  // audio rebuilt. That is exactly the case this whole dance exists for.
  if (first < startTimestamp) return false;
  if (first > startTimestamp && !format.supportsTimestampedMediaData) return false;

  const sourceCodec = await track.getCodec();
  if (!sourceCodec || !format.getSupportedAudioCodecs().includes(sourceCodec)) return false;
  if (opts?.codec && opts.codec !== sourceCodec) return false;
  if (opts?.numberOfChannels !== undefined && opts.numberOfChannels !== await track.getNumberOfChannels()) return false;
  if (opts?.sampleRate !== undefined && opts.sampleRate !== await track.getSampleRate()) return false;
  return true;
}

/**
 * When a track has to be re-encoded and nobody said at what quality, Mediabunny
 * encodes at its own "high" default — which can be several times the bitrate the
 * file already had, so a plain format conversion hands back a *bigger* file.
 * Cap it at what the source was using instead.
 */
async function cappedQuality(track, opts, copies) {
  if (copies || !track || opts?.quality !== undefined || opts?.bitrate !== undefined) return opts;
  const source = await estimateBitrate(track);
  return source ? { ...opts, quality: quality(source) } : opts;
}

const DISCARD_REASONS = {
  unknown_source_codec: 'UniLab could not identify the codec of one track, so it was left out.',
  undecodable_source_codec: 'This browser cannot decode one of the tracks, so it was left out.',
  no_encodable_target_codec: 'This browser cannot encode that track into the chosen format, so it was left out.',
  max_track_count_reached: 'The chosen format had no room for one of the tracks.',
  max_track_count_of_type_reached: 'The chosen format cannot hold that kind of track.',
};

/** Human-readable warnings for tracks the conversion had to drop (never the user's own `discard: true`). */
export function describeDiscards(discardedTracks) {
  return discardedTracks
    .filter((d) => d.reason !== 'discarded_by_user')
    .map((d) => `${d.track.type === 'video' ? 'Video' : 'Audio'}: ${DISCARD_REASONS[d.reason] ?? d.reason}`);
}

/**
 * The one function every media tool is built on: read `file`, apply the given
 * video/audio/trim options, write out a new file of type `container`.
 *
 * Options mirror Mediabunny's Conversion API:
 *   video  — { discard, width, height, fit, crop, rotate, frameRate, codec, quality, ... }
 *   audio  — { discard, codec, quality, numberOfChannels, sampleRate, ... }
 *   trim   — { start, end } in seconds
 *
 * `onProgress(fraction, processedSeconds)` fires as the conversion advances, and
 * an `AbortSignal` cancels it. Resolves to `{ blob, ext, mime, warnings }`.
 */
export async function convertMedia({
  file, container, video, audio, trim, tags, onProgress, signal,
}) {
  const spec = CONTAINERS[container];
  if (!spec) throw new Error(`Unknown output format "${container}"`);

  // Audio-only containers: be explicit rather than letting the video track get
  // silently dropped, which would otherwise show up as a scary warning.
  const videoOptions = spec.kind === 'audio' ? { discard: true } : video;

  // Deliberately *not* defaulting `audio.codec` here. Naming a codec is a
  // request to encode in it, so a default would quietly re-encode the audio of
  // every trim and container swap — turning a two-second copy into a two-minute
  // transcode, and losing quality for nothing. When the caller says nothing,
  // Mediabunny copies the stream if the container allows it and picks a codec
  // itself if it doesn't.
  const wantsMp3 = !audio?.discard && (audio?.codec === 'mp3' || container === 'mp3');
  if (wantsMp3) await ensureMp3Encoder();

  const input = openMedia(file);
  try {
    const format = spec.make();
    const output = new Output({ format, target: new BufferTarget() });

    // Mediabunny's own default start, mirrored so the copy tests below agree
    // with what the conversion will actually decide.
    const startTimestamp = trim?.start ?? Math.max(await input.getFirstTimestamp(), 0);
    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    const [videoCopies, audioCopies] = await Promise.all([
      willCopyVideo(videoTrack, videoOptions, format, startTimestamp),
      willCopyAudio(audioTrack, audio, format, startTimestamp),
    ]);
    const [resolvedVideo, resolvedAudio] = await Promise.all([
      cappedQuality(videoTrack, videoOptions, videoCopies),
      cappedQuality(audioTrack, audio, audioCopies),
    ]);

    const conversion = await Conversion.init({
      input,
      output,
      video: resolvedVideo,
      audio: resolvedAudio,
      trim,
      tags,
      showWarnings: false,
    });

    if (!conversion.isValid) {
      const why = describeDiscards(conversion.discardedTracks);
      throw new Error(
        why.length
          ? `Nothing could be written to a ${spec.label} file. ${why.join(' ')}`
          : `Nothing could be written to a ${spec.label} file — every track was excluded.`
      );
    }

    if (onProgress) conversion.onProgress = onProgress;
    let onAbort;
    if (signal) {
      if (signal.aborted) await conversion.cancel();
      onAbort = () => { conversion.cancel(); };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      await conversion.execute();
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('The converted file came back empty. Try a different output format.');
    return {
      blob: new Blob([buffer], { type: spec.mime }),
      ext: spec.ext,
      mime: spec.mime,
      warnings: describeDiscards(conversion.discardedTracks),
      // True when the picture was carried across untouched — tools use this to
      // promise "no quality lost" only when that is actually true.
      videoCopied: videoCopies,
      audioCopied: audioCopies,
    };
  } finally {
    input.dispose();
  }
}

/** True when `err` is the cancellation a user asked for, not a real failure. */
export function isCanceled(err) {
  return err?.name === 'ConversionCanceledError' || /cancel/i.test(err?.message ?? '');
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * Grabs still frames at the given timestamps (seconds). Yields
 * `{ canvas, timestamp, index }` in order — sorted timestamps decode fastest,
 * since each packet then only has to be decoded once.
 *
 * Usage:
 *   for await (const frame of grabFrames(file, [0, 1, 2], { width: 640 })) { … }
 */
export async function* grabFrames(file, timestamps, { width, height, fit = 'contain', signal } = {}) {
  const input = openMedia(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('That file has no video track to take frames from.');
    if (!(await track.canDecode())) throw new Error('This browser cannot decode that video. Try converting it to MP4 (H.264) first.');

    const sink = new CanvasSink(track, {
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      fit,
      poolSize: 2,
    });
    let index = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
      if (signal?.aborted) return;
      if (wrapped) yield { canvas: wrapped.canvas, timestamp: wrapped.timestamp, index };
      index++;
    }
  } finally {
    input.dispose();
  }
}

/** Grabs one frame as a canvas — handy for thumbnails and trim previews. */
export async function grabFrame(file, timestamp, options = {}) {
  for await (const frame of grabFrames(file, [Math.max(0, timestamp)], options)) return frame.canvas;
  return null;
}

/**
 * Streams every decoded frame between two timestamps, which is what the GIF and
 * frame-export tools iterate over. Yields `{ canvas, timestamp, duration }`.
 */
export async function* streamFrames(file, { start = 0, end = Infinity, width, height, fit = 'contain', signal } = {}) {
  const input = openMedia(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('That file has no video track.');
    if (!(await track.canDecode())) throw new Error('This browser cannot decode that video. Try converting it to MP4 (H.264) first.');

    const sink = new CanvasSink(track, {
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      fit,
      poolSize: 2,
    });
    for await (const wrapped of sink.canvases(start, end)) {
      if (signal?.aborted) return;
      yield wrapped;
    }
  } finally {
    input.dispose();
  }
}

// ---------------------------------------------------------------------------
// Bitrate maths
// ---------------------------------------------------------------------------

/**
 * Works out the video bitrate that lands a clip near `targetBytes`.
 * Container overhead is real (a few percent), so aim at 94% of the target and
 * subtract whatever the audio track will take.
 */
export function bitrateForTargetSize({ targetBytes, durationSeconds, audioBitrate = 128_000, floor = 120_000 }) {
  if (!(durationSeconds > 0)) return floor;
  const totalBits = targetBytes * 8 * 0.94;
  const videoBits = totalBits - audioBitrate * durationSeconds;
  return Math.max(floor, Math.round(videoBits / durationSeconds));
}

/** `new Quality({ bitrate })`, or a named level like 'high'. */
export function quality(value) {
  if (value instanceof Quality) return value;
  if (typeof value === 'number') return new Quality({ bitrate: Math.round(value) });
  return new Quality(value);
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/** 75.4 → "1:15.4" (or "1:02:03" past an hour). `decimals` controls the tenths. */
export function formatDuration(seconds, { decimals = 0 } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = decimals ? s.toFixed(decimals).padStart(decimals + 3, '0') : String(Math.floor(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "1:15.4", "75.4" and "1:02:03" all parse to seconds. Returns null if unusable. */
export function parseTimecode(text) {
  const t = String(text).trim();
  if (!t) return null;
  const parts = t.split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || !/^\d*\.?\d*$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const seconds = nums.reduce((total, n) => total * 60 + n, 0);
  return seconds >= 0 ? seconds : null;
}

/** Rounds to even — most encoders reject odd pixel dimensions in 4:2:0 video. */
export function evenSize(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Long loops must hand control back to the browser or the tab freezes.
 * `setTimeout(0)` — never `requestAnimationFrame`, which stops firing entirely
 * when the tab is in the background and would hang a long export.
 */
export function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
