/*
 * Image -> Trunic words, entirely client side.
 *
 * Plain script: `TrunicRecognize` in the browser (after trunic.js), and
 * require('./recognize.js') in node. It works on anything shaped like a canvas
 * ImageData: { width, height, data } with RGBA bytes.
 *
 * Pipeline
 *   1. threshold   grey level, Otsu split, ink = the darker class (flipped when
 *                  the image is light-on-dark).
 *   2. spines      the word bar is one horizontal line that runs through every
 *                  glyph of a word. Rows of ink that hold the same long
 *                  horizontal run for two or more rows, with no ink just past
 *                  either end on the next rows, are spines; roofs and slants
 *                  change by a couple of pixels per row, so they are not. The
 *                  size thresholds scale with the strokes' typical run length.
 *   3. cells       glyphs sit on a fixed pitch along the spine. Candidate pitches
 *                  are fitted to the spine lengths (each is one bar run plus
 *                  whole pitches) and limited to what the stroke width allows;
 *                  the one under which the most cells decode to chart glyphs
 *                  wins. Spines off that ladder (feet of V-shaped keels and the
 *                  like) and text lines within a glyph height of a stronger one
 *                  are dropped. The pitch also gives the glyph height, so scale
 *                  needs no configuring.
 *   4. sampling    each cell is probed along the 13 segment centrelines and at
 *                  the circle position, using the geometry measured from the
 *                  sample image (Trunic.MEASURED.sample) and the chart's
 *                  segment shapes (Trunic.SEGMENTS) mapped into that frame. A
 *                  cell is read at a few sub-pixel offsets and the valid
 *                  reading that finds the most ink is kept.
 *   5. decode      the masks go through Trunic.decodeGlyph.
 *
 * Around that, recognize() copes with a poor picture in two ways. It reads the image
 * twice, once with the global level and once with a level taken from each pixel's
 * surroundings (shadows, gradients, noise), and keeps the reading that decodes more
 * glyphs. And when the ink says the text is tilted (estimateSkew: the angle that
 * piles the ink into the fewest rows), it straightens the picture and reads again,
 * keeping the better reading. Tilts up to 8 degrees either way are searched.
 *
 * Works for glyphs from roughly 30 px tall up; tested on the sample at 0.75x to 3x,
 * with blur, sub-pixel shifts, light noise, inverted colours, one-sided shadows and
 * tilts. Perspective (a photo taken from the side) is not corrected.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./trunic.js'));
  else root.TrunicRecognize = factory(root.Trunic);
})(typeof self !== 'undefined' ? self : this, function (Trunic) {
  'use strict';

  var SAMPLE = Trunic.MEASURED.sample;
  var SAMPLE_H = SAMPLE.box.h;            // the measured sample glyph is 40 px tall
  // At the sample's scale a horizontal run shorter than 10 px is never a word bar,
  // and a bar's ends move by up to a pixel from row to row (antialiasing). Both
  // grow with the picture, measured by how long the typical horizontal ink run is.
  var MIN_SPINE_RUN = 10;
  var RUN_DRIFT = 1;
  var BRIDGE_GAP = 2.5;                   // largest gap (px at the sample's scale) between bar pieces taken as one bar
  var TYPICAL_RUN = SAMPLE.medianRun;     // the median horizontal ink run at the sample's scale
  var ADAPTIVE_HALF = 20;                 // half the local-mean window at the sample's scale (px)
  var MAX_SIZES = 4;                      // text sizes read per picture (body, captions, headings...)
  var MIN_SIZE_SCORE = 4;
  var SAME_SIZE = 0.15;                   // pitches this close (relative) are the same text size                 // a further size must net this many decoding cells to count as text
  var SOLID_HALF = 24;                    // half the window that tells solid ink from strokes (px at the sample's scale)
  var SOLID_FILL = 0.9;                   // share of that window that must be ink for the area to count as solid
  var POLARITY_DEVIATION = 45;            // grey levels from the local mean that count as a sharp stroke pixel
  var ADAPTIVE_MARGIN = 0.12;             // ink is this much darker than its surroundings

  // ---- 1. threshold -----------------------------------------------------------

  function toGray(img) {
    var n = img.width * img.height, d = img.data, g = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      // Rec. 601 luma; transparent pixels count as white paper.
      var a = d[j + 3] / 255;
      var y = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      g[i] = Math.round(y * a + 255 * (1 - a));
    }
    return g;
  }

  /** Otsu's method: the level that best separates dark from light pixels. */
  function otsuLevel(gray) {
    var hist = new Array(256).fill(0), i;
    for (i = 0; i < gray.length; i++) hist[gray[i]]++;
    var total = gray.length, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var wB = 0, sumB = 0, best = -1, level = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; level = i; }
    }
    return level;
  }

  /**
   * Whether the strokes are darker than their ground. "Ink is the minority class" fails
   * when a dark bezel or night sky fills most of the frame, so look at the strokes
   * instead: they are thin, so a stroke pixel differs sharply from the mean of its
   * surroundings, while the paper beside it differs only a little. Whichever sign the
   * sharply different pixels mostly have is the ink's.
   */
  function darkOnLight(gray, width, height) {
    var half = Math.max(6, Math.round(Math.min(width, height) / 50));
    var stride = width + 1, integral = new Float64Array(stride * (height + 1)), x, y;
    for (y = 0; y < height; y++) {
      var row = 0;
      for (x = 0; x < width; x++) {
        row += gray[y * width + x];
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
      }
    }
    var dark = 0, light = 0;
    for (y = 0; y < height; y += 2) {
      var y0 = Math.max(0, y - half), y1 = Math.min(height, y + half + 1);
      for (x = 0; x < width; x += 2) {
        var x0 = Math.max(0, x - half), x1 = Math.min(width, x + half + 1);
        var mean = (integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0]) /
          ((x1 - x0) * (y1 - y0));
        var d = gray[y * width + x] - mean;
        if (d < -POLARITY_DEVIATION) dark++;
        else if (d > POLARITY_DEVIATION) light++;
      }
    }
    return dark >= light;
  }

  /**
   * @param darkInk  true for dark strokes on a light ground, false for light on dark;
   *                 left out, the picture is judged as a whole (darkOnLight)
   * @returns {{width:number, height:number, ink:Uint8Array, level:number, darkInk:boolean}}
   *   `ink[y * width + x]` is 1 where a pixel belongs to a stroke.
   */
  function threshold(img, scale, darkInk) {
    var gray = toGray(img);
    var level = otsuLevel(gray);
    var n = gray.length, ink = new Uint8Array(n);
    for (var i = 0; i < n; i++) if (gray[i] <= level) ink[i] = 1;
    if (darkInk === undefined) darkInk = darkOnLight(gray, img.width, img.height);
    if (!darkInk) {                 // light strokes on a dark ground
      for (i = 0; i < n; i++) ink[i] ^= 1;
    }
    var bin = { width: img.width, height: img.height, ink: ink, level: level, method: 'otsu', darkInk: darkInk };
    if (scale) {
      bin.ink = localInk(gray, img.width, img.height, darkInk, scale);
      bin.method = 'adaptive';
    }
    return bin;
  }

  /**
   * Ink by comparing each pixel with the mean of the window around it, which holds
   * up under shadows, gradients and heavy noise where one global level does not.
   * The window is about a glyph wide and grows with the strokes (`scale`, see
   * strokeScale), so a stroke is always much thinner than it.
   */
  function localInk(gray, width, height, darkInk, scale) {
    var half = Math.max(8, Math.round(ADAPTIVE_HALF * scale));
    var stride = width + 1, integral = new Float64Array(stride * (height + 1));
    var x, y;
    for (y = 0; y < height; y++) {
      var row = 0;
      for (x = 0; x < width; x++) {
        row += gray[y * width + x];
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
      }
    }
    var ink = new Uint8Array(gray.length);
    for (y = 0; y < height; y++) {
      var y0 = Math.max(0, y - half), y1 = Math.min(height, y + half + 1);
      for (x = 0; x < width; x++) {
        var x0 = Math.max(0, x - half), x1 = Math.min(width, x + half + 1);
        var mean = (integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0]) /
          ((x1 - x0) * (y1 - y0));
        var v = gray[y * width + x];
        ink[y * width + x] = (darkInk ? v < mean * (1 - ADAPTIVE_MARGIN) : v > mean * (1 + ADAPTIVE_MARGIN) && v > mean + 12) ? 1 : 0;
      }
    }
    return ink;
  }

  /**
   * Delete solid dark areas and everything attached to them. A glyph's strokes are
   * thin, so a window about half a glyph high is never nearly full of ink on a glyph;
   * on a dark screen, a shadow or a black border it is. Those areas (and the edges and
   * letters touching them) otherwise read as endless word bars.
   */
  function removeSolid(bin, scale) {
    var w = bin.width, h = bin.height, ink = bin.ink;
    var half = Math.max(6, Math.round(SOLID_HALF * scale));
    var stride = w + 1, integral = new Int32Array(stride * (h + 1)), x, y;
    for (y = 0; y < h; y++) {
      var row = 0;
      for (x = 0; x < w; x++) {
        row += ink[y * w + x];
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
      }
    }
    var stack = [];
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
      for (x = 0; x < w; x++) {
        if (!ink[y * w + x]) continue;
        var x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
        var filled = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
        if (filled >= SOLID_FILL * (x1 - x0) * (y1 - y0)) stack.push(y * w + x);
      }
    }
    var removed = stack.length;
    while (stack.length) {                       // clear the whole connected piece
      var i = stack.pop();
      if (!ink[i]) { continue; }
      ink[i] = 0;
      var px = i % w, py = (i - px) / w;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          var nx = px + dx, ny = py + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && ink[ny * w + nx]) stack.push(ny * w + nx);
        }
      }
    }
    return removed;
  }

  // ---- 2. spines --------------------------------------------------------------

  /** How much larger than the sample the strokes in this image are (median horizontal run, relative). */
  function strokeScale(bin) {
    var w = bin.width, h = bin.height, ink = bin.ink, hist = [], total = 0;
    // Runs across a solid dark area (a screen, a shadow) say nothing about the strokes.
    var longest = Math.max(30, Math.round(w / 8));
    for (var y = 0; y < h; y++) {
      var start = -1;
      for (var x = 0; x <= w; x++) {
        var on = x < w && ink[y * w + x] === 1;
        if (on && start < 0) start = x;
        else if (!on && start >= 0) {
          if (x - start <= longest) { hist[x - start] = (hist[x - start] || 0) + 1; total++; }
          start = -1;
        }
      }
    }
    if (!total) return 1;
    var seen = 0;
    for (var len = 1; len < hist.length; len++) {
      seen += hist[len] || 0;
      if (seen * 2 >= total) return Math.min(8, Math.max(0.5, len / TYPICAL_RUN));
    }
    return 1;
  }

  /**
   * Horizontal word bars: [{x0, x1, y0, y1}], x inclusive, y0..y1 the stable rows
   * (y1 inclusive); sorted top to bottom, then left to right.
   */
  function findSpines(bin, scale, lenient, noBridge) {
    var w = bin.width, h = bin.height, ink = bin.ink;
    if (scale === undefined) scale = strokeScale(bin);
    var minRun = Math.max(6, Math.round(MIN_SPINE_RUN * scale)), drift = Math.max(1, Math.round(RUN_DRIFT * scale));
    var minPiece = Math.max(3, Math.round(minRun / 2)), bridge = noBridge ? -1 : Math.max(1, Math.round(BRIDGE_GAP * scale));
    var open = [], done = [];
    for (var y = 0; y < h; y++) {
      // Some fonts leave a small gap between the bars of neighbouring glyphs of one word,
      // so pieces of at least half a bar that nearly touch are taken as one run.
      var pieces = [], runs = [], start = -1, base = y * w;
      for (var x = 0; x <= w; x++) {
        var on = x < w && ink[base + x] === 1;
        if (on && start < 0) start = x;
        else if (!on && start >= 0) {
          if (x - start >= minPiece) pieces.push([start, x - 1]);
          start = -1;
        }
      }
      for (var q = 0; q < pieces.length; q++) {
        var last = runs.length ? runs[runs.length - 1] : null;
        if (last && pieces[q][0] - last[1] - 1 <= bridge) last[1] = pieces[q][1];
        else runs.push([pieces[q][0], pieces[q][1]]);
      }
      runs = runs.filter(function (run) { return run[1] - run[0] + 1 >= minRun; });
      var next = [];
      for (var r = 0; r < runs.length; r++) {
        var run = runs[r], chain = null;
        for (var c = 0; c < open.length; c++) {
          var o = open[c];
          if (o.lastY === y - 1 && Math.abs(o.x0 - run[0]) <= drift && Math.abs(o.x1 - run[1]) <= drift) {
            chain = o; open.splice(c, 1); break;
          }
        }
        if (!chain) chain = { x0: run[0], x1: run[1], y0: y, lastY: y, minX0: run[0], maxX1: run[1] };
        chain.lastY = y; chain.x0 = run[0]; chain.x1 = run[1];
        chain.minX0 = Math.min(chain.minX0, run[0]); chain.maxX1 = Math.max(chain.maxX1, run[1]);
        next.push(chain);
      }
      for (c = 0; c < open.length; c++) done.push(open[c]);
      open = next;
    }
    for (c = 0; c < open.length; c++) done.push(open[c]);

    // The bar ends flush with its glyph boxes, so the rows above and below it
    // have no ink just past either end. The turn of a roof, a V of slants or
    // any other diagonal shape still has arms running outward there.
    var nearest = Math.max(2, Math.round(1.5 * scale)), farthest = nearest + Math.max(1, Math.round(scale));
    function widerNeighbour(c, y) {
      if (y < 0 || y >= h) return false;
      var base = y * w;
      for (var d = nearest; d <= farthest; d++) {
        if (c.minX0 - d >= 0 && ink[base + c.minX0 - d]) return true;
        if (c.maxX1 + d < w && ink[base + c.maxX1 + d]) return true;
      }
      return false;
    }

    var spines = [];
    done.forEach(function (c) {
      var rows = c.lastY - c.y0 + 1, len = c.maxX1 - c.minX0 + 1;
      if (rows < 2 || rows > Math.max(8, len * 0.35)) return;
      if (!lenient && (widerNeighbour(c, c.y0 - 1) || widerNeighbour(c, c.lastY + 1))) return;
      spines.push({ x0: c.minX0, x1: c.maxX1, y0: c.y0, y1: c.lastY });
    });
    // A thick bar can break into pieces where its lower rows are ragged; keep only
    // the longest of any pieces that sit on the same rows over the same columns.
    spines = spines.filter(function (s, i) {
      return !spines.some(function (o, j) {
        if (i === j || o.y0 > s.y1 + 1 || o.y1 < s.y0 - 1) return false;
        var overlap = Math.min(s.x1, o.x1) - Math.max(s.x0, o.x0) + 1;
        var longer = o.x1 - o.x0 > s.x1 - s.x0 || (o.x1 - o.x0 === s.x1 - s.x0 && j < i);
        return longer && overlap * 2 >= s.x1 - s.x0 + 1;
      });
    });
    spines.sort(function (a, b) { return a.y0 - b.y0 || a.x0 - b.x0; });
    return spines;
  }

  // ---- 3. pitch, cells --------------------------------------------------------

  var PITCH = SAMPLE.pitch;               // glyph pitch / glyph height
  var BAR_RUN = SAMPLE.barRun;            // one glyph's bar run / glyph height
  var BETA = BAR_RUN / PITCH;             // bar run in pitches (~1.1: neighbouring bars overlap)
  var BAR_CENTRE = SAMPLE.barCentre;      // bar centre from the glyph top / glyph height

  function spineLen(s) { return s.x1 - s.x0 + 1; }

  /**
   * Candidate ladders: [{pitch, bar, spines}] (px; `spines` lists the indexes of
   * the spines whose length is one bar run plus whole pitches). Each distinct spine
   * length is tried as a word of 1..12 glyphs. Several candidates can explain the
   * same bars (halving the pitch always does), and a few lines that are not bars
   * can look like short ones, so the caller picks by how well cells decode.
   */
  function pitchCandidates(spines) {
    var lens = spines.map(spineLen), out = [], seen = {};
    var reps = lens.slice().sort(function (a, b) { return a - b; }).filter(function (v, i, all) {
      return !i || v - all[i - 1] > 2;
    });
    reps.forEach(function (rep) {
      for (var k = 1; k <= 12; k++) {
        var p0 = rep / (k - 1 + BETA);
        if (p0 < 4) break;
        var fit = fitLadder(lens, p0, BETA * p0);
        var key = Math.round(fit.pitch * 2) + ':' + fit.spines.join(',');
        if (!fit.spines.length || seen[key]) continue;
        seen[key] = true;
        out.push(fit);
      }
    });
    return out;
  }

  function ladderCounts(lens, pitch, bar) {
    var tol = Math.max(2, 0.1 * pitch), inliers = [], counts = [];
    lens.forEach(function (len, i) {
      var n = Math.round((len - bar) / pitch) + 1;
      if (n >= 1 && Math.abs(len - (bar + (n - 1) * pitch)) <= tol) { inliers.push(i); counts[i] = n; }
    });
    return { inliers: inliers, counts: counts };
  }

  // Inliers of the nominal ladder, then least squares  len = bar + (n - 1) * pitch  on
  // them, and again on the inliers of that fit until the set stops changing (the
  // nominal ladder drifts off the long words, so the first set is too small). With a
  // single rung there is nothing to fit and the nominal ladder stands.
  function fitLadder(lens, pitch, bar) {
    var set = ladderCounts(lens, pitch, bar);
    for (var round = 0; round < 6 && set.inliers.length; round++) {
      var N = set.inliers.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
      set.inliers.forEach(function (i) {
        var m = set.counts[i] - 1;
        sx += m; sy += lens[i]; sxx += m * m; sxy += m * lens[i];
      });
      var den = N * sxx - sx * sx;
      if (!den) break;
      var p = (N * sxy - sx * sy) / den, c = (sy - p * sx) / N;
      if (!(p > 0) || Math.abs(c / p - BETA) > 0.25 * BETA) break;
      pitch = p; bar = c;
      var next = ladderCounts(lens, pitch, bar);
      var same = next.inliers.length === set.inliers.length;
      set = next;
      if (same) break;
    }
    return { pitch: pitch, bar: bar, spines: set.inliers };
  }

  // ---- 4. sampling ------------------------------------------------------------

  // Segment centrelines in the sample frame (px at SAMPLE_H tall, origin at the
  // top of the glyph, x from the glyph's vertical axis). The chart's tap-target
  // lines (Trunic.SEGMENTS[id].hit, in the 30x46 chart frame) are mapped in.
  var CHART = Trunic.FRAME;
  var MAP_X = SAMPLE.box.w / CHART.w, MAP_Y = SAMPLE_H / CHART.h;
  var PROBES = {};
  Trunic.INNER_SEGMENTS.concat(Trunic.OUTER_SEGMENTS).forEach(function (id) {
    var hit = Trunic.SEGMENTS[id].hit, pts = [];
    [0.1, 0.3, 0.5, 0.7, 0.9].forEach(function (t) {
      pts.push([
        ((hit[0] + (hit[2] - hit[0]) * t) - CHART.w / 2) * MAP_X,
        (hit[1] + (hit[3] - hit[1]) * t) * MAP_Y
      ]);
    });
    PROBES[id] = pts;
  });
  // The circle sits just under the glyph: diameter 0.2 and gap 0.1 of its height.
  var CIRCLE_CY = SAMPLE_H * (1 + SAMPLE.circleGap - 0.1) + SAMPLE_H * SAMPLE.circleDiameter / 2;
  var CIRCLE_R = SAMPLE_H * SAMPLE.circleDiameter / 2;

  function inkAt(bin, x, y) {
    return x >= 0 && y >= 0 && x < bin.width && y < bin.height && bin.ink[y * bin.width + x] === 1;
  }

  // Where the glyph's axis and top really are can be half a pixel or so off the
  // fitted position, and the segment lines are only a few pixels apart, so each
  // cell is read at a few small offsets and the best aligned valid reading is kept.
  var NUDGES = [[0, 0], [-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5], [-1, 0], [1, 0], [-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5]];

  // One reading of the 13 segments at a fixed position. `ink` is how many probe
  // points landed on a stroke: a reading that is off its glyph misses strokes, so
  // among readings that decode, the one that finds the most ink is the best aligned.
  function readSegments(bin, cx, top, k) {
    var inner = 0, outer = 0, ink = 0;
    function on(id) {
      var pts = PROBES[id], hits = 0;
      for (var i = 0; i < pts.length; i++) {
        if (inkAt(bin, Math.floor(cx + pts[i][0] * k), Math.floor(top + pts[i][1] * k))) hits++;
      }
      ink += hits;
      return hits * 2 > pts.length;
    }
    Trunic.INNER_SEGMENTS.forEach(function (id) { if (on(id)) inner |= Trunic.bitOf(Trunic.INNER_SEGMENTS, id); });
    Trunic.OUTER_SEGMENTS.forEach(function (id) { if (on(id)) outer |= Trunic.bitOf(Trunic.OUTER_SEGMENTS, id); });
    return { inner: inner | Trunic.BAR_BIT, outer: outer, ink: ink };
  }

  function hasCircle(bin, cx, top, k) {
    var ccy = top + CIRCLE_CY * k, r = Math.max(1, Math.round(CIRCLE_R * k));
    var total = 0, filled = 0;
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        total++;
        if (inkAt(bin, Math.round(cx) + dx, Math.round(ccy) + dy)) filled++;
      }
    }
    return filled / total >= 0.35;
  }

  /** Read one glyph cell: cx is its vertical axis, top its top edge, k = px per sample px. */
  function sampleCell(bin, cx, top, k) {
    var best = null, nominal = null;
    for (var i = 0; i < NUDGES.length; i++) {
      var g = readSegments(bin, cx + NUDGES[i][0] * k, top + NUDGES[i][1] * k, k);
      if (!nominal) nominal = g;
      var d = Trunic.decodeGlyph(g);
      if (!d.unknown && !d.empty && (!best || g.ink > best.ink)) best = g;
    }
    var read = best || nominal;
    return { inner: read.inner, outer: read.outer, vowelFirst: hasCircle(bin, cx, top, k) };
  }

  // ---- 5. words ---------------------------------------------------------------

  function readSpine(bin, spine, fit, count) {
    var pitch = fit.pitch, k = pitch / (PITCH * SAMPLE_H);
    var h = SAMPLE_H * k;
    var yc = (spine.y0 + spine.y1 + 1) / 2;
    var top = yc - BAR_CENTRE * h;
    var glyphs = [];
    for (var i = 0; i < count; i++) {
      var cx = spine.x0 + fit.bar / 2 + i * pitch;
      var g = sampleCell(bin, cx, top, k);
      g.x = cx;
      glyphs.push(g);
    }
    return glyphs;
  }

  function countGlyphs(spine, fit) {
    return Math.max(1, Math.round((spineLen(spine) - fit.bar) / fit.pitch) + 1);
  }

  // Cells that decode to a chart glyph minus cells that do not, when the ladder's
  // spines are cut up. The right pitch decodes everything it explains; a pitch that
  // is too small cuts glyphs into slivers (many more cells, mostly nonsense), and a
  // ladder built on a stray line explains few spines.
  function scoreCandidate(bin, spines, fit) {
    var score = 0;
    fit.spines.forEach(function (i) {
      readSpine(bin, spines[i], fit, countGlyphs(spines[i], fit)).forEach(function (g) {
        var d = Trunic.decodeGlyph(g);
        score += !d.unknown && !d.empty ? 1 : -1;
      });
    });
    return score;
  }

  // The flat foot of a V of keels or the like can pass for a short bar, but it lies
  // within the glyph height of the real bar and is much shorter than a text line's
  // bars. Lines are at least a glyph height apart, so of the spines clustered at
  // one height only the cluster with the most bar length within reach is kept.
  function keepTextLines(spines, indexes, glyphHeight) {
    var clusters = [];
    indexes.slice().sort(function (a, b) { return spines[a].y0 - spines[b].y0; }).forEach(function (i) {
      var yc = (spines[i].y0 + spines[i].y1 + 1) / 2, c = clusters[clusters.length - 1];
      if (c && Math.abs(yc - c.y) <= Math.max(2, 0.08 * glyphHeight)) {
        c.members.push(i); c.length += spineLen(spines[i]);
      } else {
        clusters.push({ y: yc, members: [i], length: spineLen(spines[i]) });
      }
    });
    var kept = [];
    clusters.sort(function (a, b) { return b.length - a.length; }).forEach(function (c) {
      var clear = kept.every(function (k) { return Math.abs(k.y - c.y) >= 0.8 * glyphHeight; });
      if (clear) kept.push(c);
    });
    var out = [];
    kept.forEach(function (c) { out.push.apply(out, c.members); });
    return out.sort(function (a, b) { return spines[a].y0 - spines[b].y0 || spines[a].x0 - spines[b].x0; });
  }

  // A glyph whose roof or foot slants past the ends of its bar fails findSpines' clean-end
  // test, so a word can be missing from a line that was otherwise found. Take such a bar
  // back (marked `weak`) when it sits on a line already found, is as long as a word of
  // whole glyphs on the chosen ladder, does not overlap a word already read, and every
  // glyph on it decodes. A weak word is only worth showing if it spells something, which
  // is for the caller to judge (reader.js keeps those that match the dictionary exactly).
  function addWeakWords(bin, lenient, fit, lines, glyphHeight) {
    var tol = Math.max(2, 0.1 * fit.pitch);
    lenient.forEach(function (s) {
      var yc = (s.y0 + s.y1 + 1) / 2, line = null, i;
      for (i = 0; i < lines.length; i++) if (Math.abs(lines[i].y - yc) <= 0.25 * glyphHeight) line = lines[i];
      if (!line) return;
      var len = spineLen(s), n = Math.round((len - fit.bar) / fit.pitch) + 1;
      if (n < 1 || n > 12 || Math.abs(len - (fit.bar + (n - 1) * fit.pitch)) > tol) return;
      var clash = line.words.some(function (w) {
        var overlap = Math.min(s.x1, w.x1) - Math.max(s.x0, w.x0) + 1;
        return overlap > 0.3 * Math.min(len, w.x1 - w.x0 + 1);
      });
      if (clash) return;
      var glyphs = readSpine(bin, s, fit, n);
      var word = Trunic.spellWord(glyphs);
      if (word.unknown) return;
      word.x0 = s.x0; word.x1 = s.x1; word.cells = glyphs; word.weak = true;
      line.words.push(word);
    });
    lines.forEach(function (line) { line.words.sort(function (a, b) { return a.x0 - b.x0; }); });
  }

  /**
   * Read every word in an image.
   * @param {{width:number,height:number,data:ArrayLike<number>}} img  RGBA pixels
   * @returns {{lines: Array<{y:number, words: Array}>, pitch:number, glyphHeight:number}}
   *   Lines run top to bottom, words left to right. Each word is a Trunic.spellWord()
   *   result ({glyphs, spelling, ipa, unknown}) plus x0/x1 (the extent of its bar) and
   *   `cells`: the raw {inner, outer, vowelFirst, x} read at every glyph position,
   *   which is what TrunicEnglish looks up.
   */
  function recognize(img, options) {
    var variants = recognizeAll(img, options), best = variants[0];
    variants.forEach(function (v) { if (v.score > best.score) best = v; });
    return best;
  }

  /**
   * Every reading of the picture: with the global (Otsu) level and with a local one,
   * and when the ink says the text is tilted, both again on the straightened picture
   * (those carry `skew`, the rotation applied; their positions are in the straightened
   * frame). A clean picture reads the same with either level; shadows, gradients and
   * noise are where the local one wins, and a tilt of over a fraction of a degree breaks
   * the word bars into slivers until it is straightened. recognize() keeps the variant
   * that decodes the most glyphs; a caller with a dictionary (reader.js) can do better,
   * line by line.
   */
  function recognizeAll(img, options) {
    var noBridge = !!(options && options.bridge === false);
    var both = !!(options && options.polarity === 'both');
    var level = readBoth(img, noBridge);
    var all = level.slice();
    var ref = level[0].score >= level[1].score ? level[0] : level[1];
    // A page can carry light text on a dark panel beside dark text on paper; the whole
    // picture is judged one way, so on request it is also read the other way round.
    if (both) all.push.apply(all, readBoth(img, noBridge, !ref.darkInk));
    var angle = estimateSkew(ref.bin, ref.scale);
    if (Math.abs(angle) >= SKEW_MIN) {
      var turned = rotate(img, angle);
      readBoth(turned, noBridge).forEach(function (v) { v.skew = angle; all.push(v); });
      if (both) readBoth(turned, noBridge, !ref.darkInk).forEach(function (v) { v.skew = angle; all.push(v); });
    }
    all.forEach(function (v) { delete v.bin; });
    return all;
  }

  function readBoth(img, noBridge, darkInk) {
    var binPlain = threshold(img, undefined, darkInk);
    var plain = readInk(binPlain, noBridge);
    var binLocal = threshold(img, Math.min(4, Math.max(1, plain.scale)), binPlain.darkInk);
    var local = readInk(binLocal, noBridge);
    plain.bin = binPlain; local.bin = binLocal;
    plain.darkInk = local.darkInk = binPlain.darkInk;
    return [plain, local];
  }

  // ---- skew -------------------------------------------------------------------

  var SKEW_MAX = 8 * Math.PI / 180;        // tilts searched, either way
  var SKEW_MIN = 0.2 * Math.PI / 180;      // smaller tilts are left alone

  /**
   * The rotation (radians, for rotate()) that makes the picture's text level. The word
   * bars of a text line are collinear, so at the right angle their centres pile up in a
   * few rows; the angle is the one that makes the length-weighted row counts most
   * uneven (largest sum of squares). Bars alone are used: card edges, shadows and
   * letters would otherwise outvote the text.
   */
  function estimateSkew(bin, scale) {
    var spines = findSpines(bin, scale);
    if (spines.length < 3) return 0;
    var w = bin.width, h = bin.height, cx = w / 2, cy = h / 2;
    var xs = [], ys = [], ws = [], i;
    spines.forEach(function (s) {
      xs.push((s.x0 + s.x1) / 2 - cx); ys.push((s.y0 + s.y1 + 1) / 2 - cy); ws.push(s.x1 - s.x0 + 1);
    });
    var bucket = Math.max(2, 3 * scale);        // a bar is a few strokes thick
    var span = Math.ceil(Math.hypot(w, h) / bucket) + 2, hist = new Float64Array(span * 2);
    function sharpness(a) {
      var s = Math.sin(a), c = Math.cos(a);
      hist.fill(0);
      for (i = 0; i < xs.length; i++) hist[Math.round((s * xs[i] + c * ys[i]) / bucket) + span] += ws[i];
      var sum = 0;
      for (i = 0; i < hist.length; i++) sum += hist[i] * hist[i];
      return sum;
    }
    var step = 0.1 * Math.PI / 180, best = 0, bestScore = sharpness(0), a;
    for (a = -SKEW_MAX; a <= SKEW_MAX; a += step) {
      var sc = sharpness(a);
      if (sc > bestScore * 1.0001) { bestScore = sc; best = a; }
    }
    return best;
  }

  /** Grey copy of `img` turned by `angle` radians about its centre; the corners take the paper colour. */
  function rotate(img, angle) {
    var w = img.width, h = img.height, gray = toGray(img), c = Math.cos(angle), s = Math.sin(angle);
    var paper = paperLevel(gray);
    var data = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var dx = x - w / 2, dy = y - h / 2;
        var sx = c * dx + s * dy + w / 2, sy = -s * dx + c * dy + h / 2;
        var v = paper;
        if (sx >= 0 && sy >= 0 && sx <= w - 1 && sy <= h - 1) {
          var x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
          var fx = sx - x0, fy = sy - y0;
          v = gray[y0 * w + x0] * (1 - fx) * (1 - fy) + gray[y0 * w + x1] * fx * (1 - fy) +
            gray[y1 * w + x0] * (1 - fx) * fy + gray[y1 * w + x1] * fx * fy;
        }
        var i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = Math.round(v);
        data[i + 3] = 255;
      }
    }
    return { width: w, height: h, data: data };
  }

  // The ground colour: the mean of the pixels on the majority side of Otsu's level.
  function paperLevel(gray) {
    var level = otsuLevel(gray), lo = 0, nLo = 0, hi = 0, nHi = 0;
    for (var i = 0; i < gray.length; i++) {
      if (gray[i] <= level) { lo += gray[i]; nLo++; } else { hi += gray[i]; nHi++; }
    }
    return nLo > nHi ? Math.round(lo / nLo) : Math.round(hi / nHi);
  }

  function readInk(bin, noBridge) {
    var scale = strokeScale(bin);
    bin = { width: bin.width, height: bin.height, ink: new Uint8Array(bin.ink), level: bin.level, method: bin.method, darkInk: bin.darkInk };
    if (removeSolid(bin, scale)) scale = strokeScale(bin);
    var spines = findSpines(bin, scale, false, noBridge);
    var none = { lines: [], pitch: 0, glyphHeight: 0, level: bin.level, score: 0, scale: scale, method: bin.method };
    if (!spines.length) return none;

    // A page can set its text at several sizes (a manual's body, its captions, its
    // headings), and one ladder only explains one of them. So the ladder that decodes
    // the most cells is read first, the bars it explains (and any bar lying across a
    // word it read) are set aside, and the next best ladder is fitted to the rest, until
    // what is left decodes too little to be text. Each line keeps its own pitch.
    var expected = PITCH * SAMPLE_H * scale;
    var lenient = findSpines(bin, scale, true, noBridge);
    var remaining = spines.map(function (_, i) { return i; });
    var lines = [], first = null;
    for (var pass = 0; pass < MAX_SIZES && remaining.length; pass++) {
      var sub = remaining.map(function (i) { return spines[i]; });
      // The first size is found near the pitch the stroke width predicts; the others are
      // sought relative to it (a page's smallest and largest text differ by a few times).
      var best = first
        ? bestLadder(bin, sub, 0.5 * first.pitch, 3 * first.pitch, lines.map(function (l) { return l.pitch; }))
        : bestLadder(bin, sub, 0.6 * expected, 1.6 * expected, []);
      if (!best || (pass > 0 && best.score < MIN_SIZE_SCORE)) break;
      if (!first) first = best;

      var glyphHeight = best.pitch / PITCH, passLines = [];
      keepTextLines(sub, best.spines, glyphHeight).forEach(function (i) {
        var s = sub[i];
        var yc = (s.y0 + s.y1 + 1) / 2;
        var line = passLines.length ? passLines[passLines.length - 1] : null;
        if (!line || Math.abs(yc - line.y) > 0.3 * glyphHeight) {
          line = { y: yc, pitch: best.pitch, bar: best.bar, glyphHeight: glyphHeight, words: [] };
          passLines.push(line);
        }
        var glyphs = readSpine(bin, s, best, countGlyphs(s, best));
        var word = Trunic.spellWord(glyphs);
        word.x0 = s.x0; word.x1 = s.x1;
        word.cells = glyphs;
        line.words.push(word);
      });
      addWeakWords(bin, lenient, best, passLines, glyphHeight);
      lines.push.apply(lines, passLines);

      remaining = remaining.filter(function (i) {
        var s = spines[i], yc = (s.y0 + s.y1 + 1) / 2;
        return !passLines.some(function (line) {
          return Math.abs(yc - line.y) < 0.8 * glyphHeight && line.words.some(function (w) {
            return Math.min(s.x1, w.x1) >= Math.max(s.x0, w.x0);
          });
        });
      });
    }
    if (!first) return none;
    lines.sort(function (a, b) { return a.y - b.y; });

    // How well the reading holds together: glyphs that decode minus glyphs that do not,
    // over the words actually kept (the ladder's own score also counts bars dropped above).
    var quality = 0;
    lines.forEach(function (line) {
      line.words.sort(function (a, b) { return a.x0 - b.x0; });
      line.words.forEach(function (w) {
        w.cells.forEach(function (g) {
          var d = Trunic.decodeGlyph(g);
          quality += !d.unknown && !d.empty ? 1 : -1;
        });
      });
    });
    // pitch, bar and glyphHeight are those of the size read first (the largest body of text)
    return { lines: lines, pitch: first.pitch, bar: first.bar, glyphHeight: first.pitch / PITCH, level: bin.level, score: quality, scale: scale, method: bin.method };
  }

  // Pick the ladder under which the most cells decode to chart glyphs; ties go to
  // the larger pitch (fewer, wider glyphs), which pitchCandidates lists first.
  // The pitch is about 5 stroke widths in any picture; ladders far from that are slivers
  // of a glyph (or several glyphs) however well they happen to decode.
  function bestLadder(bin, spines, lo, hi, readPitches) {
    var candidates = pitchCandidates(spines).filter(function (c) {
      // what is left at a size already read is what keepTextLines dropped, not a new size
      return !readPitches.some(function (p) { return Math.abs(c.pitch - p) < SAME_SIZE * p; });
    });
    var plausible = candidates.filter(function (c) { return c.pitch >= lo && c.pitch <= hi; });
    var best = null;
    (plausible.length ? plausible : candidates).forEach(function (c) {
      c.score = scoreCandidate(bin, spines, c);
      if (!best || c.score > best.score || (c.score === best.score && c.pitch > best.pitch)) best = c;
    });
    return best;
  }

  return {
    threshold: threshold,
    findSpines: findSpines,
    strokeScale: strokeScale,
    pitchCandidates: pitchCandidates,
    sampleCell: sampleCell,
    recognize: recognize,
    recognizeAll: recognizeAll,
    readInk: readInk,
    rotate: rotate,
    PROBES: PROBES
  };
});
