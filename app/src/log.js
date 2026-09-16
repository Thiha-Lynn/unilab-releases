// Diagnostics that are safe to ship.
//
// rule.md, CCA §26 rule 12: "Production builds must not print filenames, file
// contents, or signed URLs to the console or to an error tracker."
//
// That rule is easy to read as a style note and it is not one. UniLab's error
// messages deliberately name the file so the student knows which one failed —
// `ui.js` throws "Could not read holiday-photo.jpg as an image", and
// `rotate-image.js` names the file in its too-large message. Those strings are
// right for a person looking at the screen. Printing them to the console is a
// different act: a filename can be an ID card, a medical certificate, or a
// scholarship transcript, and the console is read by extensions, screen-sharing
// and anything the browser hands it to.
//
// So the message keeps naming the file on screen, and nothing goes to the
// console in a production build. `import.meta.env.DEV` is substituted with a
// literal `false` at build time, so the minifier deletes these bodies entirely —
// the guarantee is in the output, not in a promise to be careful.

// `typeof` first: Vite substitutes `import.meta.env` in a bundle, but this module
// is also pulled in by the node test runner, where it does not exist at all.
const DEV = typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true;

/** Non-fatal diagnostic. Silent in production. */
export function debug(...args) {
  if (DEV) console.warn(...args);
}

/**
 * An error that already has a home on screen.
 *
 * Callers show the message to the user themselves; this only adds the console
 * copy a developer wants while working, and only in development.
 */
export function debugError(err) {
  if (DEV) console.error(err);
}
