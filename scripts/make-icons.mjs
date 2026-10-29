// Draws the extension icon (five rising bars, red to green, one per rating)
// at each size the manifest needs. Run with `npm run icons`.
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const BACKGROUND = [15, 23, 42];
const BAR_COLORS = [
  [240, 62, 62],
  [253, 126, 20],
  [252, 196, 25],
  [81, 207, 102],
  [32, 201, 151]
];
const SUPERSAMPLE = 4;

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Colour of the icon at a point in unit coordinates (0..1), or null for transparent.
function colorAt(x, y) {
  if (!insideRoundedRect(x, y, 0, 0, 1, 1, 0.22)) return null;
  const barWidth = 0.11;
  const gap = 0.045;
  const left = (1 - (5 * barWidth + 4 * gap)) / 2;
  const bottom = 0.8;
  for (let i = 0; i < 5; i++) {
    const x0 = left + i * (barWidth + gap);
    const top = bottom - (0.2 + i * 0.105);
    if (insideRoundedRect(x, y, x0, top, x0 + barWidth, bottom, 0.025)) return BAR_COLORS[i];
  }
  return BACKGROUND;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const c = colorAt((px + (sx + 0.5) / SUPERSAMPLE) / size, (py + (sy + 0.5) / SUPERSAMPLE) / size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        pixels[i] = Math.round(r / a);
        pixels[i + 1] = Math.round(g / a);
        pixels[i + 2] = Math.round(b / a);
      }
      pixels[i + 3] = Math.round((a / SUPERSAMPLE ** 2) * 255);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // no filter
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of SIZES) {
  const file = new URL(`../extension/icons/icon-${size}.png`, import.meta.url);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote extension/icons/icon-${size}.png`);
}
