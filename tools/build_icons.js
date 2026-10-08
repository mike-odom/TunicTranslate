#!/usr/bin/env node
/*
 * Renders the app icons (icon-192.png, icon-512.png, apple-touch-icon.png) from the
 * same glyph as favicon.svg: a Trunic word bar with a V of slants, in the accent
 * colour on the page background. The glyph sits inside the central 56% of the
 * square so the icons also work as maskable icons.
 *
 *   node tools/build_icons.js
 *
 * No dependencies: pixels are rasterised here (4x4 supersampling) and written
 * as PNG with node's zlib.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = [0x14, 0x16, 0x1c];
const FG = [0xf2, 0xb4, 0x41];
const STROKE = 6;
// Glyph frame is 30 x 46; strokes are clipped to it (the slants run past the sides).
const FRAME = { w: 30, h: 46 };
const SEGMENTS = [[15, 3, 15, 43], [0, 22, 30, 22], [-2, 7, 15, 15], [32, 7, 15, 15]];
const GLYPH_SHARE = 0.56;     // glyph height as a share of the icon

function onStroke(x, y) {
  if (x < 0 || y < 0 || x > FRAME.w || y > FRAME.h) return false;
  return SEGMENTS.some(([x1, y1, x2, y2]) => {
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    const t = ((x - x1) * dx + (y - y1) * dy) / len2;
    if (t < 0 || t > 1) return false;     // butt caps, like the favicon
    const px = x1 + t * dx, py = y1 + t * dy;
    return Math.hypot(x - px, y - py) <= STROKE / 2;
  });
}

function render(size) {
  const k = (size * GLYPH_SHARE) / FRAME.h;
  const ox = (size - FRAME.w * k) / 2, oy = (size - FRAME.h * k) / 2;
  const rgba = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          if (onStroke((px + (sx + 0.5) / N - ox) / k, (py + (sy + 0.5) / N - oy) / k)) hit++;
        }
      }
      const a = hit / (N * N), i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(BG[c] + (FG[c] - BG[c]) * a);
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size) {
  const rgba = render(size), stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8;      // bit depth
  head[9] = 6;      // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const root = path.join(__dirname, '..');
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(root, name), png(size));
  console.log('wrote', name);
}
