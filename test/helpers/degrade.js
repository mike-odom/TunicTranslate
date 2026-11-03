'use strict';
// Degraded copies of a grey RGBA image ({width, height, data}), for robustness tests.
// Each returns a new image; noise uses a fixed seed so runs are repeatable.

function copy(img) {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** Darken from left (1) to right (1 - strength): uneven lighting. */
function gradient(img, strength) {
  const out = copy(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const f = 1 - strength * (x / img.width), i = (y * img.width + x) * 4;
      for (let k = 0; k < 3; k++) out.data[i + k] *= f;
    }
  }
  return out;
}

/** Uniform noise of +/- amplitude / 2 grey levels per pixel. */
function noise(img, amplitude) {
  const out = copy(img);
  let seed = 1;
  for (let i = 0; i < out.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const n = (seed / 4294967296 - 0.5) * amplitude;
    for (let k = 0; k < 3; k++) out.data[i + k] += n;
  }
  return out;
}

/** Squash the levels into [floor, floor + range]: a washed-out photo. */
function lowContrast(img, floor, range) {
  const out = copy(img);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let k = 0; k < 3; k++) out.data[i + k] = floor + out.data[i + k] * range / 255;
  }
  return out;
}

/** Rotate by `degrees` about the centre (bilinear), filling the corners with white. */
function rotate(img, degrees) {
  const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const w = img.width, h = img.height, out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
  const at = (x, y) => img.data[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2, dy = y - h / 2;
      const sx = c * dx + s * dy + w / 2, sy = -s * dx + c * dy + h / 2;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const v = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
        at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
      out.data.fill(Math.round(v), (y * w + x) * 4, (y * w + x) * 4 + 3);
    }
  }
  return out;
}

module.exports = { gradient, noise, lowContrast, rotate };
