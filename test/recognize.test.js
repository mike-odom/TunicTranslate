'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jpeg = require('jpeg-js');
const T = require('../trunic.js');
const Recognize = require('../recognize.js');
const English = require('../english.js');
const Words = require('../words.js');

const SAMPLE = path.join(__dirname, 'fixtures', 'smp_trunic.jpg');
const sample = jpeg.decode(fs.readFileSync(SAMPLE), { useTArray: true });
const reading = Recognize.recognize(sample);
const english = English.translate(reading);

// A word reads as expected when it is the expected word or sounds exactly like it
// (the dictionary cannot tell homophones apart; see the hole/whole test below).
function wordMatches(entry, expected) {
  return entry.english === expected || (entry.cost === 0 && entry.alternatives.includes(expected));
}

test('the sample image has six lines, each read without an unmatched glyph', () => {
  assert.equal(reading.lines.length, 6);
  for (const line of reading.lines) {
    assert.ok(line.words.length > 0);
    for (const word of line.words) {
      assert.equal(word.unknown, false, word.spelling);
      assert.ok(word.cells.length > 0);
      assert.ok(word.glyphs.length > 0);
    }
  }
  // glyph height and pitch come out near the measured 40 px and 20.6 px
  assert.ok(Math.abs(reading.glyphHeight - T.MEASURED.sample.box.h) < 1.5, String(reading.glyphHeight));
  assert.ok(Math.abs(reading.pitch - 0.516 * 40) < 0.5, String(reading.pitch));
});

test('every line of the sample decodes to English words', () => {
  assert.equal(english.length, 6);
  english.forEach((line, i) => {
    assert.ok(line.words.length > 0, 'line ' + (i + 1));
    for (const w of line.words) assert.notEqual(w.english, null, 'line ' + (i + 1) + ': ' + w.spelling);
    assert.ok(!line.text.includes('?'), line.text);
  });
});

test('the first line of the sample reads: the lever overworked the fulcrum shattered a hole in', () => {
  const expected = 'the lever overworked the fulcrum shattered a hole in'.split(' ');
  const line = english[0];
  assert.equal(line.words.length, expected.length);
  expected.forEach((word, i) => {
    assert.ok(wordMatches(line.words[i], expected[i]),
      'word ' + (i + 1) + ': wanted "' + word + '", got "' + line.words[i].english + '" (' + line.words[i].alternatives + ')');
  });
});

test('the first line is read glyph by glyph as these sounds', () => {
  assert.equal(english[0].phonetic, 'theh lee-vir ohv-ir-wir-k-t theh fou-l-k-reh-m sha-tir-d eh hoh-l in');
});

test('lines and words come out in reading order', () => {
  for (const line of reading.lines) {
    for (let i = 1; i < line.words.length; i++) assert.ok(line.words[i].x0 > line.words[i - 1].x1);
  }
  for (let i = 1; i < reading.lines.length; i++) assert.ok(reading.lines[i].y > reading.lines[i - 1].y);
  // line 5 has words whose bars start on neighbouring pixel rows; it must still read left to right
  assert.equal(english[4].text.split(' ')[1], 'beginning');
});

function spellings(r) { return r.lines.map((l) => l.words.map((w) => w.spelling)); }

// Gray, bilinearly resampled copy of an image: `factor` scales it, (dx, dy) shifts it in source pixels.
function resample(img, factor, dx = 0, dy = 0) {
  const w = Math.round(img.width * factor), h = Math.round(img.height * factor);
  const out = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  const luma = (x, y) => {
    x = Math.min(img.width - 1, Math.max(0, x)); y = Math.min(img.height - 1, Math.max(0, y));
    return img.data[(y * img.width + x) * 4];   // the sample is grey: R = G = B
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / factor - 0.5 + dx, sy = (y + 0.5) / factor - 0.5 + dy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const v = luma(x0, y0) * (1 - fx) * (1 - fy) + luma(x0 + 1, y0) * fx * (1 - fy) +
        luma(x0, y0 + 1) * (1 - fx) * fy + luma(x0 + 1, y0 + 1) * fx * fy;
      out.data.fill(Math.round(v), (y * w + x) * 4, (y * w + x) * 4 + 3);
      out.data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return out;
}

function blur3(img) {
  const out = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let sum = 0, n = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const xx = x + i, yy = y + j;
          if (xx >= 0 && yy >= 0 && xx < img.width && yy < img.height) { sum += img.data[(yy * img.width + xx) * 4]; n++; }
        }
      }
      out.data.fill(Math.round(sum / n), (y * img.width + x) * 4, (y * img.width + x) * 4 + 3);
    }
  }
  return out;
}

test('reading does not depend on image scale', () => {
  const k = 2, w = sample.width * k, h = sample.height * k;
  const big = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / k) * sample.width + Math.floor(x / k)) * 4, d = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) big.data[d + c] = sample.data[s + c];
    }
  }
  assert.deepEqual(spellings(Recognize.recognize(big)), spellings(reading), 'nearest-neighbour 2x');
  for (const factor of [0.75, 1.5, 3]) {
    assert.deepEqual(spellings(Recognize.recognize(resample(sample, factor))), spellings(reading), factor + 'x smooth');
  }
});

test('reading survives blur and sub-pixel shifts', () => {
  assert.deepEqual(spellings(Recognize.recognize(blur3(sample))), spellings(reading), 'blur');
  assert.deepEqual(spellings(Recognize.recognize(resample(sample, 1, 0.5, 0.5))), spellings(reading), 'half-pixel shift');
  assert.deepEqual(spellings(Recognize.recognize(resample(sample, 2, 0.3, -0.4))), spellings(reading), '2x with a shift');
});

test('light strokes on a dark ground read the same as dark on light', () => {
  const inverted = { width: sample.width, height: sample.height, data: new Uint8Array(sample.data) };
  for (let i = 0; i < inverted.data.length; i += 4) {
    for (let c = 0; c < 3; c++) inverted.data[i + c] = 255 - inverted.data[i + c];
  }
  assert.deepEqual(spellings(Recognize.recognize(inverted)), spellings(reading));
});

test('an image with no word bars reads as empty', () => {
  const blank = { width: 50, height: 50, data: new Uint8Array(50 * 50 * 4).fill(255) };
  assert.deepEqual(Recognize.recognize(blank).lines, []);
});

// ---- English lookup ---------------------------------------------------------

test('every Trunic sound maps to ARPAbet symbols the dictionary knows', () => {
  const known = new Set(Words.symbols.concat(['AA/AO']));
  for (const g of T.ALL_GLYPHS) {
    const symbols = English.ARPABET[g.id];
    assert.ok(symbols && symbols.length > 0, g.id);
    for (const s of symbols) assert.ok(known.has(s), g.id + ' -> ' + s);
  }
});

test('words.js holds the 50,000 most common pronounceable words, most frequent first', () => {
  const lines = Words.entries.split('\n');
  assert.equal(lines.length, 50000);
  assert.deepEqual(lines.slice(0, 3).map((l) => l.split('|')[0]), ['the', 'of', 'and']);
  for (const w of ['overworked', 'fulcrum', 'shattered']) {
    assert.ok(lines.some((l) => l.startsWith(w + '|')), w);
  }
});

test('an exact pronunciation costs nothing', () => {
  const hit = English.lookup(['DH', 'AH']);
  assert.equal(hit.word, 'the');
  assert.equal(hit.cost, 0);
});

test('swapping a similar vowel is cheaper than swapping a consonant or another vowel', () => {
  const swap = (a, b) => English.editCost(['B', a, 'T'], ['B', b, 'T']);
  assert.ok(swap('AA', 'AO') < 5);                 // cot / caught
  assert.ok(swap('IH', 'IY') < 5);                 // bit / beat
  assert.equal(swap('AA', 'IY'), 10);              // unrelated vowels
  assert.equal(English.editCost(['B', 'AA', 'T'], ['D', 'AA', 'T']), 10);   // consonants
  assert.equal(English.editCost(['B', 'AA', 'T'], ['B', 'AA', 'D']), 10);
  assert.equal(English.editCost(['B', 'AA', 'T'], ['B', 'T', 'T']), 15);    // vowel for consonant
  assert.equal(English.editCost(['B', 'AA', 'T'], ['B', 'AA']), 10);        // a missing sound
  assert.equal(English.editCost(['B', 'AA', 'T', 'AH'], ['B', 'AA', 'T']), 6);   // a dropped schwa
  assert.equal(English.editCost(['B', 'AA/AO', 'T'], ['B', 'AO', 'T']), 0);  // the "ah" glyph is either
  assert.equal(English.editCost(['B', 'AA/AO', 'T'], ['B', 'AA', 'T']), 0);
});

test('a similar vowel is tried before a different word', () => {
  const near = English.lookup(['B', 'AO', 'T', 'AH', 'L']);   // bottle is B AA T AH L
  assert.equal(near.word, 'bottle');
  assert.equal(near.cost, 3);
  assert.equal(near.exact, false);
});

test('words at the same cost go to the more frequent one, except preferred words', () => {
  // hole and whole are both HH OW L; whole is the more common word, but hole is preferred
  const hit = English.lookup(['HH', 'OW', 'L']);
  assert.equal(hit.word, 'hole');
  assert.equal(hit.cost, 0);
  assert.ok(hit.alternatives.includes('whole'));
  const lines = Words.entries.split('\n').map((l) => l.split('|')[0]);
  assert.ok(lines.indexOf('whole') < lines.indexOf('hole'));
  // an ordinary tie still goes to the more frequent word
  const pair = English.lookup(['B', 'EH', 'R']);   // bare / bear
  assert.equal(pair.word, lines.indexOf('bare') < lines.indexOf('bear') ? 'bare' : 'bear');
});

test('the schwa swaps cheaply with any vowel, while consonant changes stay expensive', () => {
  const cost = (heard, intended) => English.editCost(['B', ...heard, 'T'], ['B', ...intended, 'T']);
  for (const vowel of ['IH', 'EH', 'AE', 'AA', 'AO', 'UH', 'UW', 'OW', 'AW', 'AY', 'EY', 'IY', 'OY', 'ER']) {
    assert.ok(cost(['AH'], [vowel]) <= 3, 'AH -> ' + vowel);
    assert.ok(cost([vowel], ['AH']) <= 3, vowel + ' -> AH');
  }
  assert.equal(cost(['AH'], ['AH']), 0);
  // cheaper than dropping the schwa, so the vowel is kept rather than deleted
  assert.ok(cost(['AH'], ['IH']) < English.editCost(['B', 'AH', 'T'], ['B', 'T']));
  // any consonant for any other consonant is still a full edit, and a consonant for a vowel more
  for (const [a, b] of [['B', 'D'], ['T', 'S'], ['M', 'N'], ['K', 'G'], ['S', 'Z'], ['P', 'B']]) {
    assert.equal(English.editCost(['AH', a, 'AH'], ['AH', b, 'AH']), 10, a + ' -> ' + b);
  }
  assert.equal(English.editCost(['B', 'AH', 'T'], ['B', 'T', 'T']), 15);
  // other vowel pairs are untouched by the schwa rule
  assert.equal(cost(['AA'], ['IY']), 10);
  assert.equal(cost(['AA'], ['AO']), 3);
});

test('an exact pronunciation is taken before any cheaper-than-a-swap fuzzy match', () => {
  // "but" is B AH T; bit, bet and bat are one cheap vowel swap away but must not win
  const exact = English.lookup(['B', 'AH', 'T']);
  assert.equal(exact.word, 'but');
  assert.equal(exact.cost, 0);
  assert.equal(exact.exact, true);
  // the "ah" glyph (AA or AO) still finds an exact word: cot is K AA T, caught is K AO T
  const either = English.lookup(['K', 'AA/AO', 'T']);
  assert.equal(either.cost, 0);
  assert.equal(either.exact, true);
  assert.ok(['cot', 'caught'].includes(either.word), either.word);
  // a stray vowel next to a consonant-only reading never beats a word that matches exactly
  assert.equal(English.lookup(['DH', 'AH']).word, 'the');
});

// ---- homophone preferences: hole/whole and flee/flea ----------------------------

const rankOf = (word) => Words.entries.split('\n').findIndex((l) => l.startsWith(word + '|'));

test('hole: the preferred spelling is chosen for HH OW L even though whole is more common', () => {
  assert.ok(rankOf('whole') < rankOf('hole'), 'whole should be the more frequent word');
  const hit = English.lookup(['HH', 'OW', 'L']);
  assert.equal(hit.word, 'hole');
  assert.equal(hit.cost, 0);
  assert.ok(hit.alternatives.includes('whole'));
});

test('whole: it stays available as the alternative and never beats hole on a tie', () => {
  const hit = English.lookup(['HH', 'OW', 'L']);
  assert.notEqual(hit.word, 'whole');
  assert.ok(hit.alternatives.includes('whole'));
  // words outside the list keep their frequency order: holy and wholly are also homophones
  const pair = English.lookup(['HH', 'OW', 'L', 'IY']);
  assert.equal(pair.word, rankOf('holy') < rankOf('wholly') ? 'holy' : 'wholly');
  assert.equal(pair.cost, 0);
});

test('flee: the preferred spelling is chosen for F L IY even though flea is more common', () => {
  assert.ok(rankOf('flea') < rankOf('flee'), 'flea should be the more frequent word');
  const hit = English.lookup(['F', 'L', 'IY']);
  assert.equal(hit.word, 'flee');
  assert.equal(hit.cost, 0);
  assert.ok(hit.alternatives.includes('flea'));
});

test('flea: it stays available as the alternative and never beats flee on a tie', () => {
  const hit = English.lookup(['F', 'L', 'IY']);
  assert.notEqual(hit.word, 'flea');
  assert.ok(hit.alternatives.includes('flea'));
});

test('the preference also settles ties between fuzzy matches', () => {
  // a doubled vowel / a stray schwa matches no word exactly, so the closest words are one edit away
  for (const [phonemes, preferred, other] of [[['HH', 'OW', 'OW', 'L'], 'hole', 'whole'], [['F', 'L', 'IY', 'AH'], 'flee', 'flea']]) {
    const hit = English.lookup(phonemes);
    assert.ok(hit.cost > 0, preferred);
    assert.equal(hit.word, preferred);
    assert.ok(hit.alternatives.includes(other), other);
  }
});

test('a preference never overrides an exact or cheaper word', () => {
  assert.equal(English.lookup(['HH', 'OW', 'L', 'D']).word, 'hold');    // not hole + a dropped D
  assert.equal(English.lookup(['F', 'L', 'IY', 'T']).word, 'fleet');    // not flee/flea + a dropped T
  assert.equal(English.lookup(['F', 'L', 'IY', 'T']).cost, 0);
});

test('a mispronounced word falls back to the closest one', () => {
  // "cat" with a stray extra consonant is no word; the nearest are one edit away
  const hit = English.lookup(['K', 'AE', 'T', 'K']);
  assert.ok(hit.cost > 0);
  assert.ok(hit.cost <= 10, String(hit.cost));
});

test('a word with an unmatched glyph has no English', () => {
  const lone = T.maskOf(T.OUTER_SEGMENTS, ['wallLowLeft']);
  assert.equal(English.lookupGlyphs([{ inner: T.BAR_BIT, outer: lone, vowelFirst: false }]), null);
});
