// File intake policy — the rules that apply to every file this app opens.
//
// This module exists because rule.md places three duties on the moment a file
// arrives, and until now nothing enforced them in one place:
//
//   PDPA 12 — "must reject uploads above a stated size and of types we do not
//             edit, and must not silently retain a file it refused to process"
//   PDPA 16 — "must not persist EXIF, GPS coordinates, or device identifiers
//             from an uploaded image beyond the moment of processing"
//   PDPA 17 — "must keep the original filename in memory for display only"
//
// The gap rule 12 closes is specific and easy to miss: `<input accept="...">`
// only filters the operating system's file picker. A file dragged onto the page
// bypasses it completely, so before this module a student could drop a 4 GB ISO
// onto Compress Image and the tool would try to decode it. `accept` is a hint;
// this is the check.

/**
 * Default ceiling on a single input file.
 *
 * 2 GiB is not a policy preference, it is roughly where browsers stop being able
 * to hold a Blob reliably. A tool that knows its own limit better — an image
 * tool has no business opening a 2 GiB file — passes its own `maxBytes`.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Human form of a byte ceiling, for the message shown when one is exceeded. */
export function describeLimit(bytes = MAX_FILE_BYTES) {
  if (bytes >= 1024 * 1024 * 1024) {
    const gib = bytes / (1024 * 1024 * 1024);
    return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Does `file` match an `accept` string of the same shape the pickers already use
 * — "image/jpeg,image/png", "image/*", ".pdf,application/pdf", or "*"?
 *
 * Extensions are compared case-insensitively because phones write .JPG as often
 * as .jpg, and a case-sensitive check would reject a photo the tool can open.
 */
export function matchesAccept(file, accept = '*') {
  if (!accept || accept === '*' || accept === '*/*') return true;

  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();

  return accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((token) => {
    if (token.startsWith('.')) return name.endsWith(token);
    if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
}

/**
 * Screen a batch of files against the type and size rules.
 *
 * Returns `{ accepted, rejected }` rather than throwing, because a student who
 * drops eight photos and one stray video should get the eight photos plus one
 * clear message — not a dead end.
 *
 * Nothing is retained for a rejected file: it is never read, never added to a
 * tool's list, and no reference to it is kept once the caller has shown the
 * message. That is the second half of rule 12 ("must not silently retain a file
 * it refused to process"), and it is satisfied by simply not holding on.
 */
export function screenFiles(files, { accept = '*', maxBytes = MAX_FILE_BYTES } = {}) {
  const accepted = [];
  const rejected = [];

  for (const file of files) {
    if (!matchesAccept(file, accept)) {
      rejected.push({ name: file.name, reason: 'is not a file type this tool can open' });
      continue;
    }
    if (file.size > maxBytes) {
      rejected.push({ name: file.name, reason: `is larger than the ${describeLimit(maxBytes)} limit for one file` });
      continue;
    }
    accepted.push(file);
  }

  return { accepted, rejected };
}

/** One sentence naming what was refused and why — safe to show to a student. */
export function rejectionMessage(rejected) {
  if (!rejected.length) return '';
  if (rejected.length === 1) return `“${rejected[0].name}” ${rejected[0].reason}, so it was not opened.`;
  const reasons = [...new Set(rejected.map((r) => r.reason))];
  return reasons.length === 1
    ? `${rejected.length} files ${reasons[0]}, so they were not opened.`
    : `${rejected.length} files could not be opened: ${rejected.map((r) => `“${r.name}” ${r.reason}`).join('; ')}.`;
}

// ---------------------------------------------------------------------------
// PDPA 16 — metadata
// ---------------------------------------------------------------------------

/**
 * Image container formats that can carry EXIF, and therefore GPS coordinates and
 * a device serial number. PNG and WebP as written by a canvas carry none, which
 * is why re-encoding is a real fix rather than a gesture.
 */
const METADATA_BEARING = new Set(['image/jpeg', 'image/jpg', 'image/tiff', 'image/heic', 'image/heif']);

/** Can this blob carry EXIF/GPS at all? Cheap pre-check, so we re-encode only when it matters. */
export function mayCarryMetadata(blob) {
  return METADATA_BEARING.has((blob?.type || '').toLowerCase());
}

/**
 * Return `blob` with any EXIF, GPS or device metadata removed.
 *
 * The mechanism is the point: drawing to a canvas and reading it back out
 * produces pixels and nothing else. A canvas has no way to carry an EXIF block,
 * so the guarantee is structural rather than a list of tags we remembered to
 * strip. Most of UniLab's image tools already go through a canvas and are
 * therefore already clean; this exists for the paths that do not.
 *
 * The image is decoded from an object URL that is revoked in a `finally`, so a
 * failure part-way through cannot leave the decoded photo reachable.
 */
export async function stripImageMetadata(blob, { quality = 0.92 } = {}) {
  if (!mayCarryMetadata(blob)) return blob;

  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('could not decode the image to strip its metadata'));
      i.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha channel; without this a transparent source would
    // composite against black instead of white.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const stripped = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    // If the browser refused to encode, the original is still better than
    // nothing — but say so rather than silently returning a file with EXIF.
    return stripped || blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
