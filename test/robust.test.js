'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jpeg = require('jpeg-js');
const T = require('../trunic.js');
const Recognize = require('../recognize.js');
const English = require('../english.js');
const degrade = require('./helpers/degrade.js');

const sample = jpeg.decode(fs.readFileSync(path.join(__dirname, 'fixtures', 'smp_trunic.jpg')), { useTArray: true });
const LINES = [
  'the lever overworked the fulcrum shattered a hole in',
  'truth will thunder open and all manner of disquiet',
  'contradictions will gnaw apart the canonical plane',
  'the thread is snagged into a squirming coil with',
  'no beginning and no end flee to your arcs',
  'old ones and become your predestined selves'
];

function read(img) {
  return English.translate(Recognize.recognize(img)).map((l) => l.text);
}

// Share of the sample's words that a reading recovers (each word counted once per occurrence).
function recovered(lines) {
  const left = new Map();
  LINES.join(' ').split(' ').forEach((w) => left.set(w, (left.get(w) || 0) + 1));
  let ok = 0;
  lines.join(' ').split(' ').forEach((w) => { if (left.get(w) > 0) { ok++; left.set(w, left.get(w) - 1); } });
  return ok / LINES.join(' ').split(' ').length;
}

test('uneven lighting: a one-sided shadow still reads all six lines', () => {
  // With one global level the dark side drowns the strokes (about a quarter of the words).
  assert.deepEqual(read(degrade.gradient(sample, 0.6)), LINES);
});

test('a washed-out, low-contrast picture reads all six lines', () => {
  assert.deepEqual(read(degrade.lowContrast(sample, 100, 150)), LINES);
});

test('moderate noise keeps nearly every word', () => {
  assert.ok(recovered(read(degrade.noise(sample, 60))) >= 0.9);
});

test('a clean picture is read with the global level, not the local one', () => {
  assert.equal(Recognize.recognize(sample).method, 'otsu');
  assert.equal(Recognize.recognize(degrade.gradient(sample, 0.6)).method, 'adaptive');
});

test('tilted pictures are straightened and read, whichever way they lean', () => {
  // Unstraightened, 1 degree already loses over half the words and 4 degrees nearly all.
  for (const degrees of [-4, -2, -1, 1, 2, 4]) {
    const result = Recognize.recognize(degrade.rotate(sample, degrees));
    const got = recovered(English.translate(result).map((l) => l.text));
    assert.ok(got >= 0.9, degrees + ' degrees: ' + got);
    // the rotation that undoes a turn by `degrees` is its opposite
    assert.ok(Math.abs(result.skew * 180 / Math.PI + degrees) < 0.3, degrees + ' degrees read as ' + result.skew);
  }
});

test('a tilt combined with a shadow still reads', () => {
  const img = degrade.gradient(degrade.rotate(sample, 2), 0.5);
  assert.ok(recovered(read(img)) >= 0.9);
});

test('level pictures are not turned', () => {
  assert.equal(Recognize.recognize(sample).skew, undefined);
});

// ---- English: a word with a glyph that matches no chart sound ---------------------

const glyph = (id) => T.glyphFromEntry(T.getGlyph(id));
const LEVER = [glyph('l'), glyph('e'), glyph('v'), glyph('ir')];
const BAD_VOWEL = { inner: T.BAR_BIT, outer: 0b101010, vowelFirst: false };   // lines that form no vowel

test('the test glyph really is unreadable', () => {
  assert.equal(T.decodeGlyph(BAD_VOWEL).unknown, true);
});

test('a word with one unreadable glyph still gets a guess, ranked as one', () => {
  const clean = English.lookupGlyphs(LEVER);
  const guess = English.lookupGlyphs([LEVER[0], BAD_VOWEL, LEVER[2], LEVER[3]]);
  assert.equal(clean.cost, 0);
  assert.ok(guess, 'no guess for a word with one bad glyph');
  assert.ok(guess.cost > 0, 'a guess must not look like an exact match');
  assert.ok([guess.word].concat(guess.alternatives).includes('lever'), guess.word + ' ' + guess.alternatives);
});

test('a half-readable consonant keeps its readable vowel half', () => {
  const half = { inner: T.BAR_BIT | 0b1110101, outer: LEVER[1].outer, vowelFirst: false };
  assert.equal(T.decodeGlyph(half).unknown, true);
  // the consonant half becomes a wildcard before the vowel's sound (ARPAbet EH for the "e" glyph)
  assert.deepEqual(English.wordPhonemes([LEVER[0], half]), ['L', '?', 'EH']);
});

test('a word that is mostly unreadable gets no guess', () => {
  assert.equal(English.lookupGlyphs([BAD_VOWEL, BAD_VOWEL, LEVER[0]]), null);
});
