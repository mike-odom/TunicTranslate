/*
 * Picture -> English, the way the app reads a still image.
 *
 * Plain script: `TrunicReader` in the browser (after recognize.js and english.js),
 * require('./reader.js') in node.
 *
 *   read(img, options)  img is {width, height, data} RGBA. Returns
 *                       { reading, lines, factor, exact }: the recognizer's reading, its
 *                       English lines (TrunicEnglish.translate), the scale the picture
 *                       was read at, and the score that chose it.
 *
 * Small or blurry photos (a phone held up to a screen) read far better when the picture
 * is enlarged first: the recognizer probes each glyph at fixed points, and a glyph only
 * 30 px tall leaves them a pixel or two from the strokes. The right enlargement is not
 * obvious from the picture, and "decodes to a valid glyph" is a weak signal (junk does
 * too), so each scale is read in full and the winner is the reading with the most words
 * that match the dictionary exactly: real text spells real words, junk almost never
 * does. A picture that already reads cleanly at its own size is not enlarged.
 *
 * Lines whose exact dictionary matches amount to less than one short word are dropped as
 * junk (card edges, the English caption beside the runes); a picture with nothing left
 * has no Trunic worth reading. Scales rarely agree on every line, so each line is taken
 * from whichever scale read it best (mergeLines).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./recognize.js'), require('./english.js'));
  } else {
    root.TrunicReader = factory(root.TrunicRecognize, root.TrunicEnglish);
  }
})(typeof self !== 'undefined' ? self : this, function (Recognize, English) {
  'use strict';

  var FACTORS = [1, 1.5, 2, 3];       // enlargements tried, in this order
  var MAX_SIDE = 4800;                // never enlarge past this many pixels on the long side
  var FULL_SEARCH_SIDE = 2000;        // pictures up to this long side are read at every scale
  var SMALL_GLYPH = 36;               // glyphs under this (px) are worth enlarging on a big picture
  var WANTED_GLYPH = 60;              // ...to about this
  var COMMON_RANK = 5000, RARE_RANK = 20000;   // frequency ranks that make a word common, or rare
  var MIN_LINE_SCORE = 2.8;           // exactScore a line needs to be kept: one exact word of two glyphs
  var MIN_LONE_WORD = 5.1;            // a line of one word needs that word to have three glyphs (3^1.5)
  var TILE_SIDE = 900;                // a page scan is also read in tiles this long on a side...
  var TILE_OVERLAP = 300;             // ...overlapping by this much, so a block cut by one tile edge is whole in another

  /** Bilinear enlargement of an RGBA image by `factor` (1 returns the image itself). */
  function enlarge(img, factor) {
    if (factor === 1) return img;
    var w = Math.round(img.width * factor), h = Math.round(img.height * factor);
    var out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    var src = img.data, sw = img.width, sh = img.height;
    for (var y = 0; y < h; y++) {
      var sy = (y + 0.5) / factor - 0.5, y0 = Math.floor(sy), fy = sy - y0;
      var ya = Math.min(sh - 1, Math.max(0, y0)) * sw, yb = Math.min(sh - 1, Math.max(0, y0 + 1)) * sw;
      for (var x = 0; x < w; x++) {
        var sx = (x + 0.5) / factor - 0.5, x0 = Math.floor(sx), fx = sx - x0;
        var xa = Math.min(sw - 1, Math.max(0, x0)), xb = Math.min(sw - 1, Math.max(0, x0 + 1));
        var o = (y * w + x) * 4;
        for (var c = 0; c < 3; c++) {
          out.data[o + c] = src[(ya + xa) * 4 + c] * (1 - fx) * (1 - fy) + src[(ya + xb) * 4 + c] * fx * (1 - fy) +
            src[(yb + xa) * 4 + c] * (1 - fx) * fy + src[(yb + xb) * 4 + c] * fx * fy;
        }
        out.data[o + 3] = 255;
      }
    }
    return out;
  }

  function glyphCount(word) { return Math.max(1, word.spelling.split('-').length); }

  /**
   * How much of a reading is real: each word of two or more glyphs that matches the
   * dictionary exactly counts for its glyphs (to the 1.5th, so one long word outweighs a
   * few short ones, which junk matches by chance).
   */
  function exactScore(lines) {
    var score = 0;
    lines.forEach(function (l) {
      var seen = {};     // the same word again is no more evidence ("mm mm mm" is junk repeating itself)
      l.words.forEach(function (w) {
        if (w.english && w.cost === 0 && !seen[w.english]) { seen[w.english] = true; score += evidence(w); }
      });
    });
    return score;
  }

  // A single glyph nearly always spells some short word ("a", "i", "oi", "mm"), so one is
  // no evidence that a line is text; a word of two or more glyphs is, the longer the more,
  // and the commoner the more: a stray pair of glyphs spells "moy" or "om" far more
  // readily than "bell", and a page is mostly made of common words.
  function evidence(word) {
    var n = glyphCount(word);
    if (n < 2) return 0;
    var weight = word.rank < COMMON_RANK ? 1 : word.rank < RARE_RANK ? 0.5 : 0.2;
    return weight * Math.pow(n, 1.5);
  }

  function wordCount(lines) {
    return lines.reduce(function (n, l) { return n + l.words.length; }, 0);
  }

  function exactWordCount(lines) {
    return lines.reduce(function (n, l) {
      return n + l.words.filter(function (w) { return w.english && w.cost === 0; }).length;
    }, 0);
  }

  // A line is worth showing when it holds an exact dictionary word of two or more glyphs
  // (single glyphs match short words by chance) and is more than that one short word:
  // two glyphs alone spell "way" or "moy" by chance too, a longer word or a second one
  // does not.
  function hasExactWord(line) {
    var score = exactScore([line]);
    var sure = line.words.filter(function (w) { return !w.weak; }).length;   // words on bars the recognizer trusted
    return score >= MIN_LINE_SCORE && (sure >= 2 || score >= MIN_LONE_WORD);
  }

  /** Reading and English with the junk lines removed from both (they stay in step). */
  function withoutJunkLines(reading, lines) {
    var keep = lines.map(hasExactWord);
    var copy = {};
    for (var k in reading) copy[k] = reading[k];
    copy.lines = reading.lines.filter(function (l, i) { return keep[i]; });
    return { reading: copy, lines: lines.filter(function (l, i) { return keep[i]; }) };
  }

  // Where a point of a straightened reading sits in the picture as given: turned back
  // by the rotation that straightened it (see Recognize.recognizeAll).
  function original(x, y, reading, size) {
    if (!reading.skew) return { x: x, y: y };
    var dx = x - size.width / 2, dy = y - size.height / 2, c = Math.cos(reading.skew), s = Math.sin(reading.skew);
    return { x: c * dx + s * dy + size.width / 2, y: -s * dx + c * dy + size.height / 2 };
  }

  // A kept line placed in the original picture: its bar height, its glyph size, and the
  // span of each word, all in the picture's own pixels.
  function place(src, line, reading, size, factor, offset) {
    var x0 = Infinity, x1 = -Infinity;
    src.words.forEach(function (w) { x0 = Math.min(x0, w.x0); x1 = Math.max(x1, w.x1); });
    var centre = original((x0 + x1) / 2, src.y, reading, size);
    var ox = offset ? offset.x : 0, oy = offset ? offset.y : 0;
    return {
      y: centre.y / factor + oy,
      glyph: (src.glyphHeight || reading.glyphHeight) / factor,
      line: line,
      score: exactScore([line]),
      spans: src.words.map(function (w) {
        var a = original(w.x0, src.y, reading, size), b = original(w.x1, src.y, reading, size);
        return [a.x / factor + ox, b.x / factor + ox];
      })
    };
  }

  // Every variant reading of the picture at one enlargement, each translated and
  // cleaned, with its kept lines placed in the original picture for merging.
  // `offset` is where `img` sits in a larger picture it was cut from (see readTiles).
  function readAt(img, factor, bridge, offset) {
    var scaled = enlarge(img, factor), size = { width: scaled.width, height: scaled.height };
    var kept = [], best = null;
    Recognize.recognizeAll(scaled, { bridge: bridge, polarity: 'both' }).forEach(function (reading) {
      var lines = English.translate(reading);
      var clean = withoutJunkLines(reading, lines);
      var attempt = { reading: reading, lines: lines, factor: factor, exact: exactScore(lines) };
      if (!best || attempt.exact > best.exact) best = attempt;
      clean.lines.forEach(function (line, i) {
        kept.push(place(clean.reading.lines[i], line, reading, size, factor, offset));
      });
    });
    best.kept = kept;
    return best;
  }

  /** The `w` x `h` part of `img` at (x, y). */
  function crop(img, x, y, w, h) {
    var out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (var row = 0; row < h; row++) {
      var from = ((y + row) * img.width + x) * 4;
      out.data.set(img.data.subarray ? img.data.subarray(from, from + w * 4) : Array.prototype.slice.call(img.data, from, from + w * 4), row * w * 4);
    }
    return out;
  }

  // Starts of the tiles along one side: as few as cover it with the wanted overlap, evenly spread.
  function tileStarts(length) {
    if (length <= TILE_SIDE) return [0];
    var n = Math.ceil((length - TILE_OVERLAP) / (TILE_SIDE - TILE_OVERLAP)), out = [];
    for (var i = 0; i < n; i++) out.push(Math.round(i * (length - TILE_SIDE) / (n - 1)));
    return out;
  }

  /**
   * A page scan read in overlapping tiles. The whole picture is thresholded and sized by
   * its dominant ink (a page's artwork and its rules outvote a small block of text), while
   * a tile holds one or two blocks, so a block the page reading overlooked reads fine in
   * the tile that holds it. Tiles that find nothing cost only their time; the lines they
   * do find are merged with the page's (mergeLines).
   */
  function readTiles(img, bridge) {
    var attempts = [];
    var tw = Math.min(TILE_SIDE, img.width), th = Math.min(TILE_SIDE, img.height);
    tileStarts(img.height).forEach(function (y) {
      tileStarts(img.width).forEach(function (x) {
        attempts.push(readAt(crop(img, x, y, tw, th), 1, bridge, { x: x, y: y }));
      });
    });
    return attempts;
  }

  /**
   * One reading per line, from every scale and variant that read it. Readings rarely
   * agree on every word (one resolves the small words, another the long ones, one slips
   * on a glyph, one drops a word), so the readings of a line are laid over each other
   * and each word's place takes the word with the most weight of agreement: readings
   * times how good a word it is (an exact common word outranks a rare one, which
   * outranks a guess; a word on a bar the recognizer doubted counts half).
   */
  function mergeLines(attempts) {
    var candidates = [];
    attempts.forEach(function (a) { candidates.push.apply(candidates, a.kept); });
    candidates.sort(function (a, b) { return b.score - a.score; });
    var clusters = [];
    candidates.forEach(function (c) {
      var home = null;
      clusters.forEach(function (k) {
        if (!home && Math.abs(k.lead.y - c.y) < 0.5 * Math.min(k.lead.glyph, c.glyph) && sharesColumn(k.lead, c)) home = k;
      });
      if (home) home.others.push(c); else clusters.push({ lead: c, others: [] });
    });
    return clusters.sort(function (a, b) { return a.lead.y - b.lead.y || a.lead.spans[0][0] - b.lead.spans[0][0]; })
      .map(function (k) { return voteWords(k.lead, k.others); });
  }

  // Two readings on one row are of the same text only if they cover some of the same
  // ground: a page's two columns share rows but not words, and a reading of one column
  // must not be voted down (or dropped as running past the text) by the other's.
  function sharesColumn(a, b) {
    var a0 = a.spans[0][0], a1 = a.spans[a.spans.length - 1][1], b0 = b.spans[0][0], b1 = b.spans[b.spans.length - 1][1];
    var overlap = Math.min(a1, b1) - Math.max(a0, b0);
    return overlap > 0.3 * Math.min(a1 - a0, b1 - b0);
  }

  // How much a reading of one word is worth in a vote. A word on a bar the recognizer
  // was unsure of (weak) is worth half: right when it spells a common word, junk otherwise.
  function wordWorth(w) {
    var worth = !w.english ? 0 : w.cost > 0 ? 0.3 : w.rank < COMMON_RANK ? 3 : w.rank < RARE_RANK ? 2 : 1;
    return w.weak ? worth / 2 : worth;
  }

  function voteWords(lead, others) {
    // Word places: the spans of every reading's words, overlapping ones taken together,
    // so a word that one reading dropped (or never resolved) still has its place.
    // Only the lead's own extent is trusted: a weaker reading can run past the text into
    // marks beside it, and nothing it finds out there is taken.
    var left = Infinity, right = -Infinity;
    lead.spans.forEach(function (sp) { left = Math.min(left, sp[0]); right = Math.max(right, sp[1]); });
    var margin = 0.5 * lead.glyph, all = [];
    [lead].concat(others).forEach(function (r, ri) {
      r.line.words.forEach(function (w, i) {
        var sp = r.spans[i];
        if (ri && (sp[0] < left - margin || sp[1] > right + margin)) return;
        all.push({ word: w, span: sp, lead: !ri });
      });
    });
    all.sort(function (a, b) { return a.span[0] - b.span[0]; });
    var slots = [];
    all.forEach(function (entry) {
      var slot = slots.length ? slots[slots.length - 1] : null;
      var overlap = slot ? Math.min(entry.span[1], slot.span[1]) - entry.span[0] : -1;
      var need = slot ? 0.5 * Math.min(entry.span[1] - entry.span[0], slot.span[1] - slot.span[0]) : 0;
      if (slot && overlap > need) {
        slot.span = [slot.span[0], Math.max(slot.span[1], entry.span[1])];
      } else {
        slot = { span: entry.span.slice(), votes: {} };
        slots.push(slot);
      }
      if (entry.lead) slot.lead = true;
      var key = entry.word.english || '?';
      var v = slot.votes[key] || (slot.votes[key] = { word: entry.word, count: 0, worth: wordWorth(entry.word) });
      v.count++;
    });
    var out = { words: [], votes: [] };   // votes: per word, every reading's word as word:count@worth
    slots.forEach(function (slot) {
      var best = null;
      Object.keys(slot.votes).forEach(function (key) {
        var v = slot.votes[key];
        if (!best || v.worth * v.count > best.worth * best.count) best = v;
      });
      // a place the lead reading has no word at is filled only by an exact dictionary word
      if (slot.lead || best.worth >= 1) {
        out.words.push(best.word);
        out.votes.push(Object.keys(slot.votes).map(function (key) { return key + ':' + slot.votes[key].count + '@' + slot.votes[key].worth; }));
      }
    });
    out.text = out.words.map(function (w) { return w.english || '?'; }).join(' ');
    out.phonetic = out.words.map(function (w) { return w.spelling; }).join(' ');
    return out;
  }

  /**
   * @param {{width:number,height:number,data:ArrayLike<number>}} img  RGBA pixels
   * @param {{factors?:number[]}} [options]  enlargements to try instead of the defaults
   */
  function read(img, options) {
    var factors = (options && options.factors) || FACTORS;
    var longSide = Math.max(img.width, img.height);
    var fits = function (f) { return f === 1 || longSide * f <= MAX_SIDE; };
    var tried = factors.filter(fits);
    if (!tried.length) tried = [1];

    var attempts = [], best = null;
    for (var i = 0; i < tried.length; i++) {
      // Bars that join neighbouring glyphs are one run in some fonts and two in others, so
      // each scale is read both ways (see Recognize.recognize) and the lines compete.
      var withBridge = readAt(img, tried[i], true), withoutBridge = readAt(img, tried[i], false);
      attempts.push(withBridge, withoutBridge);
      var attempt = withBridge.exact >= withoutBridge.exact ? withBridge : withoutBridge;
      if (!best || attempt.exact > best.exact) best = attempt;
      // A small picture is read at every scale: that is cheap, and a scale that reads a
      // line the others miss is found only by trying. A big one (a page scan) costs
      // seconds per scale, so after its first reading only the scale its smallest text
      // calls for is tried (small or blurred glyphs read better enlarged), or 2x once
      // when nothing was read at all.
      if (i === 0 && longSide > FULL_SEARCH_SIDE) {
        if (!options || options.tiles !== false) attempts.push.apply(attempts, readTiles(img, withBridge.exact >= withoutBridge.exact));
        var kept = withBridge.kept.concat(withoutBridge.kept), smallest = Infinity;
        kept.forEach(function (k) { smallest = Math.min(smallest, k.glyph); });
        var want = !kept.length ? 2 : smallest < SMALL_GLYPH ? Math.min(3, Math.ceil(2 * WANTED_GLYPH / smallest) / 2) : 0;
        tried = want && fits(want) ? [1, want] : [1];
      }
    }
    var lines = mergeLines(attempts);
    // Nothing worth showing: say so rather than present junk (a picture with no runes in it).
    return { reading: best.reading, lines: lines, factor: best.factor, exact: best.exact };
  }

  return { read: read, enlarge: enlarge, exactScore: exactScore, internals: { readAt: readAt, mergeLines: mergeLines } };
});
