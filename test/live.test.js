'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jpeg = require('jpeg-js');
const Recognize = require('../recognize.js');
const English = require('../english.js');
const Live = require('../live.js');
const degrade = require('./helpers/degrade.js');

const sample = jpeg.decode(fs.readFileSync(path.join(__dirname, 'fixtures', 'smp_trunic.jpg')), { useTArray: true });
const reading = Recognize.recognize(sample);
const translation = English.translate(reading);
const frame = Live.describe(reading, translation, { width: sample.width, height: sample.height });

// A canvas context that records what is drawn and where.
function fakeContext(width, height) {
  const calls = { texts: [], plates: [], clears: 0 };
  return {
    calls,
    canvas: { width, height },
    font: '',
    fillStyle: '',
    clearRect() { calls.clears++; },
    fillRect(x, y, w, h) { calls.plates.push({ x, y, w, h }); },
    measureText(text) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]);
      return { width: text.length * px * 0.55 };
    },
    fillText(text, x, y) {
      calls.texts.push({ text, x, y, size: Number(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]), color: this.fillStyle });
    }
  };
}

test('describe lists every word of the frame with its box inside the picture', () => {
  const total = reading.lines.reduce((n, l) => n + l.words.length, 0);
  assert.equal(frame.words.length, total);
  assert.equal(frame.width, sample.width);
  assert.equal(frame.height, sample.height);
  for (const w of frame.words) {
    assert.ok(w.x0 >= 0 && w.x1 <= sample.width && w.x1 > w.x0, JSON.stringify(w));
    assert.ok(w.top >= 0 && w.top + w.height <= sample.height, JSON.stringify(w));
    assert.ok(w.english && w.phonetic);
  }
  // words follow reading order: the first is "the" at the start of line one
  assert.equal(frame.words[0].english, translation[0].words[0].english);
  assert.equal(frame.words[0].phonetic, 'theh');
});

test('describe output survives a structured clone (it is posted from the worker)', () => {
  assert.deepEqual(structuredClone(frame), frame);
  assert.equal('cells' in frame.lines[0].words[0], false);
});

test('a frame that reads no words keeps the last good result', () => {
  const blank = { width: 50, height: 50, lines: [], words: [] };
  assert.equal(Live.keepGood(frame, blank), frame);
  assert.equal(Live.keepGood(frame, null), frame);
  assert.equal(Live.keepGood(null, blank), null);
  assert.equal(Live.keepGood(blank, blank), blank);
  // a frame with words replaces it
  const other = { width: 10, height: 10, lines: [], words: [{ x0: 0, x1: 5, top: 0, height: 5, english: 'a', phonetic: 'ah' }] };
  assert.equal(Live.keepGood(frame, other), other);
});

test('a real blank image yields an empty description, so the last result stays', () => {
  const blankImg = { width: 50, height: 50, data: new Uint8Array(50 * 50 * 4).fill(255) };
  const blankReading = Recognize.recognize(blankImg);
  const blank = Live.describe(blankReading, English.translate(blankReading), { width: 50, height: 50 });
  assert.equal(blank.words.length, 0);
  assert.equal(Live.keepGood(frame, blank), frame);
});

test('draw puts each English word over its word with the phonetic spelling smaller underneath', () => {
  const ctx = fakeContext(1, 1);
  Live.draw(ctx, frame);
  assert.equal(ctx.canvas.width, sample.width);      // the overlay takes the frame's size
  assert.equal(ctx.canvas.height, sample.height);
  assert.equal(ctx.calls.plates.length, frame.words.length);
  assert.equal(ctx.calls.texts.length, frame.words.length * 2);
  frame.words.forEach((w, i) => {
    const english = ctx.calls.texts[i * 2], phonetic = ctx.calls.texts[i * 2 + 1];
    assert.equal(english.text, w.english);
    assert.equal(phonetic.text, w.phonetic);
    assert.ok(phonetic.size < english.size, 'phonetic is smaller: ' + w.english);
    assert.ok(phonetic.y > english.y, 'phonetic is underneath: ' + w.english);
    // centred over the detected word
    assert.ok(Math.abs(english.x - (w.x0 + w.x1) / 2) < 0.01);
    assert.ok(english.y > w.top && phonetic.y < w.top + w.height + w.height * 0.25, 'over the word: ' + w.english);
    // on a plate that covers the word
    const plate = ctx.calls.plates[i];
    assert.ok(plate.x <= w.x0 && plate.x + plate.w >= w.x1);
  });
});

test('draw clears the previous overlay and writes "?" for a word with no English', () => {
  const ctx = fakeContext(frame.width, frame.height);
  Live.draw(ctx, { width: frame.width, height: frame.height, lines: [], words: [{ x0: 10, x1: 70, top: 5, height: 40, english: null, phonetic: 'k-t' }] });
  assert.equal(ctx.calls.clears, 1);
  assert.deepEqual(ctx.calls.texts.map((t) => t.text), ['?', 'k-t']);
  Live.draw(ctx, null);
  assert.equal(ctx.calls.clears, 2);
  assert.equal(ctx.calls.texts.length, 2);      // nothing new drawn
});

test('describe carries word boxes of a straightened frame back to the camera frame', () => {
  const size = { width: sample.width, height: sample.height };
  const tiltedReading = Recognize.recognize(degrade.rotate(sample, 3));
  assert.ok(tiltedReading.skew, 'the tilted frame should have been straightened');
  const tilted = Live.describe(tiltedReading, English.translate(tiltedReading), size);
  assert.equal(tilted.words.length, frame.words.length);

  // degrade.rotate turns the picture about its centre, so each word of the level frame
  // should sit where that turn puts it. Compare word centres on the bar line.
  const a = 3 * Math.PI / 180;
  const barY = (w) => w.top + 0.5 * w.height;   // the same offset on both sides
  let compared = 0;
  frame.words.forEach((w, i) => {
    const got = tilted.words[i];
    if (got.english !== w.english) return;
    const dx = (w.x0 + w.x1) / 2 - size.width / 2, dy = barY(w) - size.height / 2;
    const x = Math.cos(a) * dx - Math.sin(a) * dy + size.width / 2;
    const y = Math.sin(a) * dx + Math.cos(a) * dy + size.height / 2;
    assert.ok(Math.abs((got.x0 + got.x1) / 2 - x) < 6, 'word ' + i + ' x');
    assert.ok(Math.abs(barY(got) - y) < 6, 'word ' + i + ' y');
    compared++;
  });
  assert.ok(compared > 30, 'only ' + compared + ' words compared');
});
