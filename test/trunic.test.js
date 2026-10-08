'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../trunic.js');

const FIX = path.join(__dirname, 'fixtures');
const measurements = JSON.parse(fs.readFileSync(path.join(FIX, 'measurements.json'), 'utf8'));

// Chart reading order, transcribed by eye from trunic.gif (row by row).
const CHART_VOWEL_IDS = ['a', 'ar', 'ah', 'ay', 'e', 'ee', 'eer', 'eh', 'ere',
  'i', 'ie', 'ir', 'oh', 'oi', 'oo', 'ou', 'ow', 'ore'];
const CHART_CONSONANT_IDS = ['b', 'ch', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
  'm', 'n', 'ng', 'p', 'r', 's', 'sh', 't', 'th',
  'dh', 'v', 'w', 'y', 'z', 'zh'];

function gifSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('latin1', 0, 3), 'GIF');
  return [b.readUInt16LE(6), b.readUInt16LE(8)];
}
function jpegSize(file) {
  const b = fs.readFileSync(file);
  let i = 2;
  while (i < b.length) {
    assert.equal(b[i], 0xff);
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    }
    i += 2 + len;
  }
  throw new Error('no SOF marker');
}

test('fixtures are the downloaded Omniglot images the measurements describe', () => {
  assert.deepEqual(gifSize(path.join(FIX, 'trunic.gif')), measurements.chart.size);
  assert.deepEqual(jpegSize(path.join(FIX, 'smp_trunic.jpg')), measurements.sample.size);
});

test('table counts equal the counts measured from the chart', () => {
  assert.equal(measurements.chart.vowelCount, 18);
  assert.equal(measurements.chart.consonantCount, 24);
  assert.deepEqual(measurements.chart.glyphsPerRow, [9, 9, 9, 9, 6]);
  assert.equal(T.VOWELS.length, measurements.chart.vowelCount);
  assert.equal(T.CONSONANTS.length, measurements.chart.consonantCount);
  assert.equal(T.INNER_SEGMENTS.length, 7);
  assert.equal(T.OUTER_SEGMENTS.length, 6);
});

test('glyph ids follow the chart reading order', () => {
  assert.deepEqual(T.VOWELS.map((v) => v.id), CHART_VOWEL_IDS);
  assert.deepEqual(T.CONSONANTS.map((c) => c.id), CHART_CONSONANT_IDS);
});

test('every vowel mask equals the segments measured under it in the chart', () => {
  measurements.chartMasks.vowels.forEach((measured, i) => {
    const entry = T.VOWELS[i];
    assert.deepEqual(entry.segments.slice().sort(), measured.outer.slice().sort(), entry.id);
  });
});

test('every consonant mask equals the segments measured under it in the chart', () => {
  measurements.chartMasks.consonants.forEach((measured, i) => {
    const entry = T.CONSONANTS[i];
    assert.deepEqual(entry.segments.slice().sort(), measured.inner.slice().sort(), entry.id);
  });
});

test('no chart vowel uses a right-hand wall, so six outer segments suffice', () => {
  assert.deepEqual(measurements.chart.unusedOuterProbes.length, 0);
});

test('every glyph has a distinct mask within its kind', () => {
  assert.equal(new Set(T.VOWELS.map((v) => v.outer)).size, 18);
  assert.equal(new Set(T.CONSONANTS.map((c) => c.inner)).size, 24);
  assert.ok(T.VOWELS.every((v) => v.outer !== 0));
  assert.ok(T.CONSONANTS.every((c) => (c.inner & ~T.BAR_BIT) !== 0));
});

test('chart glyphs all draw the bar', () => {
  assert.ok(T.ALL_GLYPHS.every((g) => (g.inner & T.BAR_BIT) !== 0));
});

test('each table entry decodes back to itself', () => {
  for (const v of T.VOWELS) {
    const d = T.decodeGlyph(T.glyphFromEntry(v));
    assert.equal(d.vowel, v, v.id);
    assert.equal(d.consonant, null);
    assert.equal(d.unknown, false);
  }
  for (const c of T.CONSONANTS) {
    const d = T.decodeGlyph(T.glyphFromEntry(c));
    assert.equal(d.consonant, c, c.id);
    assert.equal(d.vowel, null);
    assert.equal(d.unknown, false);
  }
});

test('consonant lookup ignores the bar bit', () => {
  const b = T.getGlyph('b');
  assert.equal(T.lookupConsonant(b.inner & ~T.BAR_BIT), b);
});

test('circle puts the vowel before the consonant', () => {
  const b = T.getGlyph('b'), ay = T.getGlyph('ay');
  const base = { inner: b.inner, outer: ay.outer };
  assert.equal(T.decodeGlyph({ ...base, vowelFirst: false }).spelling, 'bay');
  assert.equal(T.decodeGlyph({ ...base, vowelFirst: true }).spelling, 'ayb');
  assert.equal(T.decodeGlyph({ ...base, vowelFirst: true }).ipa, 'eɪb');
});

test('unmatched segment combinations are flagged, not guessed', () => {
  const lone = T.maskOf(T.OUTER_SEGMENTS, ['wallLowLeft']);
  assert.equal(T.lookupVowel(lone), null);
  const d = T.decodeGlyph({ inner: T.BAR_BIT, outer: lone });
  assert.equal(d.unknown, true);
  assert.equal(d.spelling, '?');
});

test('a glyph with only the bar is empty', () => {
  const d = T.decodeGlyph({ inner: T.BAR_BIT, outer: 0 });
  assert.equal(d.empty, true);
  assert.equal(d.spelling, '');
});

test('words separate glyph spellings and skip blank glyphs', () => {
  const g = (id, vowelFirst) => ({ ...T.glyphFromEntry(T.getGlyph(id)), vowelFirst: !!vowelFirst });
  const word = T.spellWord([g('th'), { inner: T.BAR_BIT, outer: 0 }, g('ar'), g('t')]);
  assert.equal(word.spelling, 'th-ar-t');
  assert.equal(word.ipa, 'θɑːt');
  assert.equal(word.unknown, false);
  // "a"+"r" stays distinguishable from the single vowel "ar"
  assert.notEqual(T.spellWord([g('a'), g('r')]).spelling, T.spellWord([g('ar')]).spelling);
});

test('geometry covers every segment and keeps tap targets inside the frame', () => {
  const ids = T.INNER_SEGMENTS.concat(T.OUTER_SEGMENTS);
  assert.deepEqual(Object.keys(T.SEGMENTS).sort(), ids.slice().sort());
  for (const id of ids) {
    const s = T.SEGMENTS[id];
    assert.ok(s.shapes.length > 0, id);
    const [x1, y1, x2, y2] = s.hit;
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      assert.ok(x >= 0 && x <= T.FRAME.w && y >= 0 && y <= T.FRAME.h, id);
    }
  }
  // measured frame: consonant box aspect 30:46
  assert.ok(Math.abs(T.FRAME.w / T.FRAME.h - measurements.chart.consonantBox.aspect) < 0.005);
});
