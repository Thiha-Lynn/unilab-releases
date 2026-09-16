import createDOMPurify from 'dompurify';
import { parse, walk, generate } from 'css-tree';

export const HTML_MAX_BYTES = 20 * 1024 * 1024;
export const HTML_MAX_PAGES = 150;
export const HTML_POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// Parse CSS rather than guessing at URL syntax. The document remains useful
// offline, and neither its styles nor its images may make a remote request.
export function localCss(css, context = 'stylesheet') {
  try {
    const ast = parse(css, { context, parseCustomProperty: true });
    walk(ast, {
      enter(node, item, list) {
        if (node.type === 'Atrule' && (/^(import|charset|namespace)$/i.test(node.name) ||
          (node.name === 'media' && /prefers-color-scheme:dark/.test(generate(node.prelude).replaceAll(' ', ''))))) {
          if (list) list.remove(item);
          return walk.skip;
        }
        if (node.type === 'Url' && !/^data:(image\/(png|jpeg|gif|webp)|font\/)/i.test(node.value) && !node.value.startsWith('#')) node.value = 'data:,';
        if (node.type === 'Raw') node.value = '';
      },
    });
    return generate(ast);
  } catch { return ''; }
}

/** Inert HTML only. The passed window makes the same sanitizer testable in jsdom. */
export function prepareHtml(source, win = window) {
  const purify = createDOMPurify(win);
  const clean = purify.sanitize(source, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'audio', 'video', 'source', 'track', 'foreignObject'],
    FORBID_ATTR: ['srcset', 'ping', 'autofocus', 'action', 'formaction', 'target'],
    ADD_TAGS: ['style'],
  });
  let missing = 0;
  for (const node of clean.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) node.removeAttribute(attr.name);
      if (['src', 'href', 'xlink:href', 'poster', 'background'].includes(name)) {
        const value = attr.value.trim();
        const localImage = node.tagName.toLowerCase() === 'img' && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value);
        if (!value.startsWith('#') && !localImage) {
          if (name === 'src' && node.tagName.toLowerCase() === 'img') {
            missing++;
            node.setAttribute('alt', `[Image not embedded: ${node.getAttribute('alt') || 'provide a self-contained HTML file'}]`);
          }
          node.removeAttribute(attr.name);
        }
      }
    }
    if (node.hasAttribute('style')) node.setAttribute('style', localCss(node.getAttribute('style'), 'declarationList'));
    if (node.tagName.toLowerCase() === 'style') node.textContent = localCss(node.textContent);
  }
  const slides = [...clean.querySelectorAll('.slide, .slides > section, section[data-slide]')]
    .filter(n => !n.parentElement?.closest('.slide, .slides > section, section[data-slide]'));
  slides.forEach((n, i) => n.setAttribute('data-unilab-slide', String(i)));
  clean.setAttribute('data-theme', 'light');
  const title = clean.querySelector('title')?.textContent?.trim() || 'HTML document';
  return { html: clean.outerHTML, title, slideCount: slides.length, missing,
    hasScripts: /<script\b/i.test(source), text: clean.querySelector('body')?.textContent || '' };
}

export function documentSource(prepared, { reading = false, fonts = '' } = {}) {
  const style = `
    :root { color-scheme:light; }
    html,body { margin:0!important; height:auto!important; min-height:0!important; overflow:visible!important; }
    body { font-family:Arial,UniLabThai,UniLabMyanmar,sans-serif; background:#fff; }
    *,*::before,*::after { animation:none!important; transition:none!important; caret-color:transparent!important; }
    .deck,.slides,.reveal { position:static!important; height:auto!important; width:100%!important; overflow:visible!important; }
    .bar-top,.nav,.dots,.progress,#progress,#controls,nav,[role="navigation"] { display:none!important; }
    [data-unilab-slide] { position:relative!important; inset:auto!important; opacity:1!important; visibility:visible!important;
      transform:none!important; width:100%!important; height:auto!important; min-height:720px!important;
      overflow:visible!important; box-sizing:border-box!important; break-after:page; }
    img,svg { max-width:100%; } pre { white-space:pre-wrap!important; overflow-wrap:anywhere; }
    ${reading ? `body { padding:0!important; color:#17202b!important; background:#fff!important; font-size:18px!important; line-height:1.6!important; }
      [data-unilab-slide] { min-height:0!important; padding:32px!important; display:block!important; border-bottom:1px solid #ddd; }
      .two,.grid,.grid.g2,.grid.g3,.grid.g4,.two.lean { display:block!important; } .box,.c { margin:12px 0!important; }
      h1 { font-size:32px!important; } h2 { font-size:28px!important; } h3 { font-size:23px!important; }
      p,li,td,.note,.plain,.lead,.c p,.box ul { font-size:18px!important; } .inner { max-width:100%!important; }
      table { width:100%!important; }` : ''}
    @media print { @page { size:${reading ? 'A4 portrait' : 'A4 landscape'}; margin:10mm; }
      [data-unilab-slide] { display:block!important; min-height:0!important; break-after:page; } body { print-color-adjust:exact; -webkit-print-color-adjust:exact; }
    }
    ${fonts}
  `;
  // This policy precedes all untrusted content, including stylesheet text.
  return prepared.html.replace(/<head[^>]*>/i, `<head><meta http-equiv="Content-Security-Policy" content="${HTML_POLICY}"><meta name="referrer" content="no-referrer">`)
    .replace(/<\/head>/i, `<style>${style}</style></head>`);
}

/** Split a long document near block boundaries; a single tall block can span pages. */
export function pageSlices(height, pageHeight, boundaries = []) {
  const pages = [];
  let top = 0;
  while (top < height - 1) {
    const limit = Math.min(height, top + pageHeight);
    const near = boundaries.filter(y => y > top + pageHeight * 0.6 && y <= limit);
    const bottom = limit < height && near.length ? Math.max(...near) : limit;
    pages.push({ top, height: bottom - top });
    if (pages.length > HTML_MAX_PAGES) throw new Error(`This document exceeds ${HTML_MAX_PAGES} pages. Split it into smaller HTML files.`);
    top = bottom;
  }
  return pages;
}
