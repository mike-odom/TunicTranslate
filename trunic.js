/*
 * Trunic glyph table, decoder and geometry.
 *
 * Plain script (no build step): loads in a browser via <script> as `Trunic`,
 * and in node via require('./trunic.js').
 *
 * Source of truth: the Omniglot chart (test/fixtures/trunic.gif). Glyph labels
 * and IPA below were transcribed from that chart; the segment masks and all
 * geometry numbers were measured from its pixels by tools/measure_glyphs.py
 * (see test/fixtures/measurements.json). test/trunic.test.js cross-checks the
 * table against those measurements.
 *
 * A glyph has 13 segments:
 *   inner 7 (consonants): upper stem, upper-left/right slants, the bar,
 *                         lower-left/right slants, lower stem
 *   outer 6 (vowels):     two roof arms, two left walls, two keel arms
 * plus an optional circle under the glyph, meaning the vowel is read first.
 *
 * The chart draws the bar in every glyph (it is the word's shared baseline),
 * so a glyph's consonant is decided by the other six inner segments; the bar
 * bit is kept in masks but ignored when looking sounds up.
 *
 * Counts measured from the chart: 24 consonants (9+9+6), 18 vowels (9+9).
 * No chart vowel uses a right-hand wall, so the outer set is exactly 6.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Trunic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var INNER_SEGMENTS = ['stemUp', 'slantUpLeft', 'slantUpRight', 'bar', 'slantLowLeft', 'slantLowRight', 'stemLow'];
  var OUTER_SEGMENTS = ['roofLeft', 'roofRight', 'wallUpLeft', 'wallLowLeft', 'keelLeft', 'keelRight'];

  var SEGMENT_LABELS = {
    stemUp: 'Upper stem', slantUpLeft: 'Upper-left slant', slantUpRight: 'Upper-right slant',
    bar: 'Middle bar', slantLowLeft: 'Lower-left slant', slantLowRight: 'Lower-right slant',
    stemLow: 'Lower stem',
    roofLeft: 'Roof left', roofRight: 'Roof right', wallUpLeft: 'Upper-left wall',
    wallLowLeft: 'Lower-left wall', keelLeft: 'Keel left', keelRight: 'Keel right'
  };

  function bitOf(list, name) {
    var i = list.indexOf(name);
    if (i < 0) throw new Error('Unknown segment: ' + name);
    return 1 << i;
  }
  function maskOf(list, names) {
    var m = 0;
    for (var i = 0; i < names.length; i++) m |= bitOf(list, names[i]);
    return m;
  }
  function namesOf(list, mask) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (mask & (1 << i)) out.push(list[i]);
    return out;
  }

  var BAR_BIT = bitOf(INNER_SEGMENTS, 'bar');

  // [id, chart spelling, IPA, chart example word, segment names]
  var VOWEL_ROWS = [
    ['a', 'a', 'æ', 'sad', 'roofLeft roofRight wallUpLeft wallLowLeft'],
    ['ar', 'ar', 'ɑː', 'arm', 'roofLeft roofRight keelLeft keelRight'],
    ['ah', 'ah', 'ɒ', 'swan', 'roofLeft wallUpLeft wallLowLeft'],
    ['ay', 'ay', 'eɪ', 'bay', 'roofLeft'],
    ['e', 'e', 'ɛ', 'end', 'wallUpLeft wallLowLeft keelLeft keelRight'],
    ['ee', 'ee', 'iː', 'bee', 'roofLeft wallUpLeft wallLowLeft keelLeft keelRight'],
    ['eer', 'eer', 'ɪɚ', 'near', 'roofLeft wallUpLeft wallLowLeft keelRight'],
    ['eh', 'eh', 'ə', 'the', 'roofLeft roofRight'],
    ['ere', 'ere', 'eɚ', 'vary', 'wallUpLeft wallLowLeft keelRight'],
    ['i', 'i', 'ɪ', 'bit', 'keelLeft keelRight'],
    ['ie', 'ie', 'aɪ', 'guy', 'roofRight'],
    ['ir', 'ir', 'ɜː', 'bird', 'roofRight wallUpLeft wallLowLeft keelLeft keelRight'],
    ['oh', 'oh', 'oʊ', 'toe', 'roofLeft roofRight wallUpLeft wallLowLeft keelLeft keelRight'],
    ['oi', 'oi', 'ɔɪ', 'toy', 'keelLeft'],
    ['oo', 'oo', 'uː', 'too', 'roofLeft roofRight wallUpLeft wallLowLeft keelLeft'],
    ['ou', 'ou', 'ʊ', 'good', 'wallUpLeft wallLowLeft keelLeft'],
    ['ow', 'ow', 'aʊ', 'how', 'keelRight'],
    ['ore', 'ore', 'ʊɚ', 'your', 'roofLeft roofRight wallUpLeft wallLowLeft keelRight']
  ];

  // Inner segments other than the bar (the bar is added to every consonant).
  var CONSONANT_ROWS = [
    ['b', 'b', 'b', 'stemUp slantLowRight'],
    ['ch', 'ch', 'tʃ', 'slantUpLeft stemLow'],
    ['d', 'd', 'd', 'stemUp slantLowLeft slantLowRight'],
    ['f', 'f', 'f', 'slantUpRight slantLowLeft stemLow'],
    ['g', 'g', 'ɡ', 'slantUpRight slantLowRight stemLow'],
    ['h', 'h', 'h', 'stemUp slantLowRight stemLow'],
    ['j', 'j', 'dʒ', 'stemUp slantLowLeft'],
    ['k', 'k', 'k', 'stemUp slantUpRight slantLowRight'],
    ['l', 'l', 'l', 'stemUp stemLow'],
    ['m', 'm', 'm', 'slantLowLeft slantLowRight'],
    ['n', 'n', 'n', 'slantUpLeft slantLowLeft slantLowRight'],
    ['ng', 'ng', 'ŋ', 'stemUp slantUpLeft slantUpRight slantLowLeft slantLowRight stemLow'],
    ['p', 'p', 'p', 'slantUpRight stemLow'],
    ['r', 'r', 'ɹ', 'stemUp slantUpRight stemLow'],
    ['s', 's', 's', 'stemUp slantUpRight slantLowLeft stemLow'],
    ['sh', 'sh', 'ʃ', 'slantUpLeft slantUpRight slantLowLeft slantLowRight stemLow'],
    ['t', 't', 't', 'slantUpLeft slantUpRight stemLow'],
    ['th', 'th', 'θ', 'stemUp slantUpLeft slantUpRight stemLow'],
    ['dh', 'th', 'ð', 'stemUp slantLowLeft slantLowRight stemLow'],
    ['v', 'v', 'v', 'stemUp slantUpLeft slantLowRight'],
    ['w', 'w', 'w', 'slantUpLeft slantUpRight'],
    ['y', 'y', 'j', 'stemUp slantUpLeft stemLow'],
    ['z', 'z', 'z', 'stemUp slantUpLeft slantLowRight stemLow'],
    ['zh', 'zh', 'ʒ', 'stemUp slantUpLeft slantUpRight slantLowLeft slantLowRight']
  ];

  var VOWELS = VOWEL_ROWS.map(function (r) {
    var segments = r[4].split(' ');
    return Object.freeze({
      id: r[0], kind: 'vowel', spelling: r[1], ipa: r[2], example: r[3],
      segments: segments, inner: BAR_BIT, outer: maskOf(OUTER_SEGMENTS, segments)
    });
  });

  var CONSONANTS = CONSONANT_ROWS.map(function (r) {
    var segments = r[3].split(' ');
    return Object.freeze({
      id: r[0], kind: 'consonant', spelling: r[1], ipa: r[2], example: null,
      segments: segments.concat('bar'), inner: maskOf(INNER_SEGMENTS, segments) | BAR_BIT, outer: 0
    });
  });

  var ALL_GLYPHS = VOWELS.concat(CONSONANTS);

  var vowelByMask = {};
  VOWELS.forEach(function (v) { vowelByMask[v.outer] = v; });
  var consonantByMask = {};
  CONSONANTS.forEach(function (c) { consonantByMask[c.inner] = c; });
  var byId = {};
  ALL_GLYPHS.forEach(function (g) { byId[g.id] = g; });

  function lookupVowel(outerMask) { return vowelByMask[outerMask] || null; }
  // The bar is the shared word line, so it never changes which consonant this is.
  function lookupConsonant(innerMask) { return consonantByMask[innerMask | BAR_BIT] || null; }
  function getGlyph(id) { return byId[id] || null; }

  /**
   * Decode one composed glyph.
   * @param {{inner:number, outer:number, vowelFirst:boolean}} glyph segment masks
   * @returns {{consonant, vowel, hasConsonant, hasVowel, unknown, empty, vowelFirst, spelling, ipa}}
   *   `consonant`/`vowel` are table entries or null; `unknown` is true when
   *   segments are drawn that match no chart sound (spelling shows '?').
   */
  function decodeGlyph(glyph) {
    var inner = glyph.inner | 0, outer = glyph.outer | 0;
    var hasConsonant = (inner & ~BAR_BIT) !== 0;
    var hasVowel = outer !== 0;
    var consonant = hasConsonant ? lookupConsonant(inner) : null;
    var vowel = hasVowel ? lookupVowel(outer) : null;
    var vowelFirst = !!glyph.vowelFirst;
    var parts = [];
    if (hasConsonant) parts.push({ text: consonant ? consonant.spelling : '?', ipa: consonant ? consonant.ipa : '?' });
    if (hasVowel) {
      var vp = { text: vowel ? vowel.spelling : '?', ipa: vowel ? vowel.ipa : '?' };
      if (vowelFirst) parts.unshift(vp); else parts.push(vp);
    }
    return {
      consonant: consonant, vowel: vowel,
      hasConsonant: hasConsonant, hasVowel: hasVowel,
      unknown: (hasConsonant && !consonant) || (hasVowel && !vowel),
      empty: !hasConsonant && !hasVowel,
      vowelFirst: vowelFirst,
      spelling: parts.map(function (p) { return p.text; }).join(''),
      ipa: parts.map(function (p) { return p.ipa; }).join('')
    };
  }

  /**
   * String glyphs into a word. Blank glyphs are skipped.
   * `spelling` separates glyphs with '-' (so "a-r" differs from "ar");
   * `ipa` is the glyph IPA run together.
   */
  function spellWord(glyphs) {
    var decoded = glyphs.map(decodeGlyph).filter(function (d) { return !d.empty; });
    return {
      glyphs: decoded,
      spelling: decoded.map(function (d) { return d.spelling; }).join('-'),
      ipa: decoded.map(function (d) { return d.ipa; }).join(''),
      unknown: decoded.some(function (d) { return d.unknown; })
    };
  }

  /** Masks for a table entry, as a composer glyph. */
  function glyphFromEntry(entry) {
    return { inner: entry.inner, outer: entry.outer, vowelFirst: false };
  }

  // ---- Geometry -----------------------------------------------------------
  // Measured from the chart (test/fixtures/measurements.json). Consonant
  // glyphs fill a 30x46 box (stroke 6); vowel glyphs are drawn at 23x36
  // (stroke 5), i.e. the same shape at ~0.77 scale. Everything below is in
  // consonant-box units (x 0..30, y 0..46) so both halves share one frame.
  // Shapes that run past x=0/30 are meant to be clipped by the glyph's
  // viewBox, as the chart clips them. Each shape is a polyline stroked with
  // `width`; `dot` is a filled circle [cx, cy, r].
  var FRAME = { w: 30, h: 46 };
  var MEASURED = {
    chart: {
      consonantBox: { w: 30, h: 46, aspect: 0.652, bar: 6, barCentre: 0.478 },
      vowelBox: { w: 23, h: 36, aspect: 0.639, bar: 5, barCentre: 0.486 }
    },
    // Fractions of the 40 px glyph height. `pitch` is the distance between
    // neighbouring glyphs along a word bar and `barRun` the bar of a lone glyph
    // (so a word of n glyphs has a bar of barRun + (n - 1) * pitch).
    sample: {
      box: { w: 24, h: 40, aspect: 0.6 }, bar: 3, barCentre: 0.487, circleDiameter: 0.2, circleGap: 0.1,
      pitch: 0.516, barRun: 0.562,
      // median length (px) of a horizontal run of ink anywhere in the picture
      medianRun: 4
    }
  };
  // Circle under the glyph: diameter 0.2 and gap 0.1 of glyph height (sample
  // image), scaled to the 46-unit frame; a ring whose hole is ~2 sample px.
  var CIRCLE = { cx: 15, cy: 46 + 4.6 + 4.6, r: 2.9, width: 3.4 };
  var TOTAL_HEIGHT = 46 + 4.6 + 9.2;

  var S = 6;      // stem / bar stroke
  var D = 4.2;    // diagonal stroke
  var W = 6.3;    // vowel wall stroke
  var line = function (pts, width, cap) { return { pts: pts, width: width, cap: cap || 'round' }; };
  var mirror = function (pts) { return pts.map(function (p) { return [FRAME.w - p[0], p[1]]; }); };

  var upperStub = line([[15, 15], [15, 22]], S, 'butt');
  var lowerDot = { dot: [15, 31, 3] };

  // hit: centreline used for tap targets in the composer (kept clear of neighbours).
  var SEGMENTS = {
    stemUp: { shapes: [line([[15, 3], [15, 22]], S)], hit: [15, 5, 15, 13] },
    slantUpLeft: { shapes: [line([[-2, 6.8], [15, 15.3]], D, 'butt'), upperStub], hit: [7, 11.3, 12, 13.8] },
    slantUpRight: { shapes: [line(mirror([[-2, 6.8], [15, 15.3]]), D, 'butt'), upperStub], hit: [23, 11.3, 18, 13.8] },
    bar: { shapes: [line([[0, 22], [30, 22]], S, 'butt')], hit: [3, 22, 27, 22] },
    slantLowLeft: { shapes: [line([[-2, 38.8], [15, 30.3]], D, 'butt'), lowerDot], hit: [4, 35.8, 10, 32.8] },
    slantLowRight: { shapes: [line(mirror([[-2, 38.8], [15, 30.3]]), D, 'butt'), lowerDot], hit: [26, 35.8, 20, 32.8] },
    stemLow: { shapes: [line([[15, 31], [15, 43]], S)], hit: [15, 34, 15, 41] },
    roofLeft: { shapes: [line([[15, 2.5], [-2, 10.9]], D)], hit: [14, 3, 6, 6.9] },
    roofRight: { shapes: [line(mirror([[15, 2.5], [-2, 10.9]]), D)], hit: [16, 3, 24, 6.9] },
    wallUpLeft: { shapes: [line([[3.25, 11], [3.25, 22]], W)], hit: [3.25, 13, 3.25, 19] },
    wallLowLeft: { shapes: [line([[3.25, 31.3], [3.25, 35.1]], W)], hit: [3.25, 31.5, 3.25, 35] },
    keelLeft: { shapes: [line([[15, 43.5], [-2, 35.1]], D)], hit: [14, 43, 6, 39.1] },
    keelRight: { shapes: [line(mirror([[15, 43.5], [-2, 35.1]]), D)], hit: [16, 43, 24, 39.1] }
  };

  return {
    INNER_SEGMENTS: INNER_SEGMENTS,
    OUTER_SEGMENTS: OUTER_SEGMENTS,
    SEGMENT_LABELS: SEGMENT_LABELS,
    BAR_BIT: BAR_BIT,
    VOWELS: VOWELS,
    CONSONANTS: CONSONANTS,
    ALL_GLYPHS: ALL_GLYPHS,
    maskOf: maskOf,
    namesOf: namesOf,
    bitOf: bitOf,
    lookupVowel: lookupVowel,
    lookupConsonant: lookupConsonant,
    getGlyph: getGlyph,
    decodeGlyph: decodeGlyph,
    spellWord: spellWord,
    glyphFromEntry: glyphFromEntry,
    FRAME: FRAME,
    CIRCLE: CIRCLE,
    TOTAL_HEIGHT: TOTAL_HEIGHT,
    MEASURED: MEASURED,
    SEGMENTS: SEGMENTS
  };
});
