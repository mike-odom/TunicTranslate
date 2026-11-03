#!/usr/bin/env node
'use strict';
// Shows what the recognizer sees in a picture: writes a PNG with the thresholded ink
// in grey, the word bars it found in red, and every glyph cell it read in green
// (decoded) or orange (no chart glyph), then prints the reading.
//
//   node tools/debug_image.js <image.jpg|png-free path> [out.png] [--scale 2] [--ink]
//
// --scale N  upscale the picture N times before reading (bilinear)
// --ink      show the thresholded ink only (default draws it over the picture)
// --method otsu|adaptive  force one threshold instead of letting recognize() choose
// --crop x,y,w,h  write only this part of the (scaled) picture
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const jpeg = require('jpeg-js');
const Trunic = require('../trunic.js');
const Recognize = require('../recognize.js');
const English = require('../english.js');

function decode(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg.decode(buf, { useTArray: true });
  throw new Error('Only JPEG input is supported: ' + file);
}

function resample(img, f) {
  if (f === 1) return img;
  const w = Math.round(img.width * f), h = Math.round(img.height * f);
  const out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  const at = (x, y, c) => img.data[(Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))) * 4 + c];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / f - 0.5, sy = (y + 0.5) / f - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        out.data[(y * w + x) * 4 + c] = at(x0, y0, c) * (1 - fx) * (1 - fy) + at(x0 + 1, y0, c) * fx * (1 - fy) +
          at(x0, y0 + 1, c) * (1 - fx) * fy + at(x0 + 1, y0 + 1, c) * fx * fy;
      }
      out.data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return out;
}

// ---- minimal PNG writer (RGB, no filtering) ----
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, name === '--ink' ? 1 : 2); return name === '--ink' ? true : v; };
  const scale = Number(flag('--scale') || 1), inkOnly = !!flag('--ink'), crop = flag('--crop'), method = flag('--method');
  const [file, outArg] = args;
  if (!file) { console.error('usage: node tools/debug_image.js <image.jpg> [out.png] [--scale N] [--ink]'); process.exit(2); }
  const img = resample(decode(file), scale);
  const forced = method ? Recognize.readInk(Recognize.threshold(img, method === 'adaptive' ? 1.5 : undefined)) : null;
  const reading = forced || Recognize.recognize(img);
  const english = English.translate(reading);

  // Redo the binarisation the winning reading used, so the picture shows it.
  const bin = Recognize.threshold(img, reading.method === 'adaptive' ? Math.min(4, Math.max(1, reading.scale)) : undefined);
  const w = img.width, h = img.height, rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const g = inkOnly ? (bin.ink[i] ? 30 : 235) : Math.round(img.data[i * 4] * 0.6 + (bin.ink[i] ? 0 : 90));
    rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = g;
  }
  const put = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) { rgb[(y * w + x) * 3] = c[0]; rgb[(y * w + x) * 3 + 1] = c[1]; rgb[(y * w + x) * 3 + 2] = c[2]; } };
  const rect = (x0, y0, x1, y1, c) => { for (let x = x0; x <= x1; x++) { put(x, y0, c); put(x, y1, c); } for (let y = y0; y <= y1; y++) { put(x0, y, c); put(x1, y, c); } };
  const skewed = reading.skew || 0;   // positions are in the straightened frame when skew is set
  reading.lines.forEach((line) => line.words.forEach((word) => {
    const gh = line.glyphHeight || reading.glyphHeight, pitch = line.pitch || reading.pitch;
    const top = line.y - Trunic.MEASURED.sample.barCentre * gh;
    rect(word.x0, line.y - 1, word.x1, line.y + 1, [255, 40, 40]);
    word.cells.forEach((cell) => {
      const d = Trunic.decodeGlyph(cell), ok = !d.unknown && !d.empty;
      rect(Math.round(cell.x - pitch / 2), Math.round(top), Math.round(cell.x + pitch / 2), Math.round(top + gh), ok ? [60, 220, 90] : [255, 150, 30]);
    });
  }));

  const out = outArg || path.join(process.env.TMPDIR || '/tmp', path.basename(file, path.extname(file)) + '.debug.png');
  if (crop) {
    const [cx, cy, cw, ch] = crop.split(',').map(Number), part = Buffer.alloc(cw * ch * 3);
    for (let y = 0; y < ch; y++) rgb.copy(part, y * cw * 3, ((cy + y) * w + cx) * 3, ((cy + y) * w + cx + cw) * 3);
    fs.writeFileSync(out, png(cw, ch, part));
  } else {
    fs.writeFileSync(out, png(w, h, rgb));
  }
  console.log('wrote', out, w + 'x' + h, 'method', reading.method, 'skew', skewed ? (skewed * 180 / Math.PI).toFixed(2) + 'deg' : 'none',
    'glyph height', reading.glyphHeight.toFixed(1), 'pitch', reading.pitch.toFixed(1), 'score', reading.score, 'sizes', [...new Set(reading.lines.map((l) => Math.round(l.glyphHeight)))].join('/'));
  english.forEach((l, i) => console.log(' ' + (i + 1) + ': ' + l.text + '   [' + l.phonetic + ']'));
}

main();
