// Reproducible raster social card. No external fonts or image services.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const canvas = createCanvas(1200, 630);
const ctx = canvas.getContext('2d');
const gradient = ctx.createLinearGradient(0, 0, 1200, 630);
gradient.addColorStop(0, '#151927'); gradient.addColorStop(1, '#193553');
ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1200, 630);
ctx.fillStyle = '#285b9b'; ctx.fillRect(0, 0, 1200, 10);
ctx.drawImage(await loadImage(readFileSync('public/icon.svg')), 76, 65, 110, 110);
ctx.font = 'bold 62px sans-serif'; ctx.fillStyle = '#ffffff'; ctx.fillText('UniLab', 212, 145);
ctx.font = 'bold 65px sans-serif';
ctx.fillText('Your files. Your tools.', 76, 277);
ctx.fillText('On your device.', 76, 357);
ctx.font = '29px sans-serif'; ctx.fillStyle = '#d4e0ee';
ctx.fillText('PDFs  /  Images  /  Video  /  Audio', 80, 422);
ctx.fillStyle = '#ffffff'; ctx.font = 'bold 25px sans-serif';
ctx.fillText('Free. Private. No file uploads.', 80, 548);
ctx.fillStyle = '#a9c7ec'; ctx.font = '24px sans-serif';
ctx.textAlign = 'right'; ctx.fillText('unilab.ztvmm.live', 1120, 548);
mkdirSync('public/social', { recursive: true });
writeFileSync('public/social/unilab-v031.png', canvas.toBuffer('image/png'));

const mark = await loadImage(readFileSync("public/icon.svg"));
for (const size of [192, 512]) { const image = createCanvas(size, size); image.getContext("2d").drawImage(mark, 0, 0, size, size); writeFileSync(`public/icon-${size}.png`, image.toBuffer("image/png")); }
