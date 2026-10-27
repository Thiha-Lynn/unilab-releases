import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const source = new URL('../node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm', import.meta.url);
const target = new URL('../public/runtime/', import.meta.url);
mkdirSync(target, { recursive: true });
writeFileSync(new URL('qpdf.bin', target), gzipSync(readFileSync(source), { level: 9 }));
