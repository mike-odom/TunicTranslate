'use strict';
// Real photos the reader has been run on, one folder each under test/fixtures/photos/:
//   image.jpg      the picture, exactly as it was uploaded
//   expected.json  { mustContain: [phrases that must appear in the lines read],
//                    maxLines: the most lines it may report (a ceiling against junk lines) }
// Write down only what is certain (the English captions printed on a card are good
// evidence), so a fixture never turns a known gap into an expectation. To add one, copy an
// upload (uploads/<id>/image.jpg) here; tools/replay_uploads.js shows what the engine reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jpeg = require('jpeg-js');
const Reader = require('../reader.js');

const ROOT = path.join(__dirname, 'fixtures', 'photos');
const folders = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((d) => fs.existsSync(path.join(ROOT, d, 'expected.json'))) : [];

for (const name of folders) {
  test('photo ' + name + ': reads what is known, without a flood of junk lines', () => {
    const dir = path.join(ROOT, name);
    const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
    const img = jpeg.decode(fs.readFileSync(path.join(dir, 'image.jpg')), { useTArray: true });
    const got = Reader.read(img).lines.map((l) => l.text);

    for (const phrase of expected.mustContain) {
      assert.ok(got.some((line) => line.includes(phrase)), '"' + phrase + '" not found in ' + JSON.stringify(got));
    }
    assert.ok(got.length <= expected.maxLines, got.length + ' lines read: ' + JSON.stringify(got));
  });
}

test('there is at least one photo fixture', () => {
  assert.ok(folders.length > 0);
});

test('a clean picture is not enlarged, and enlarging keeps the picture whole', () => {
  const sample = jpeg.decode(fs.readFileSync(path.join(__dirname, 'fixtures', 'smp_trunic.jpg')), { useTArray: true });
  assert.equal(Reader.read(sample).factor, 1);
  const big = Reader.enlarge(sample, 2);
  assert.equal(big.width, sample.width * 2);
  assert.equal(big.height, sample.height * 2);
  assert.equal(Reader.enlarge(sample, 1), sample);
});

test('a picture with no runes in it reads as nothing', () => {
  // The sky and artwork above the card in the high-resolution photo: lots of edges, no Trunic.
  const photo = jpeg.decode(fs.readFileSync(path.join(ROOT, 'west-bell-hires', 'image.jpg')), { useTArray: true });
  const rows = 480;
  const art = { width: photo.width, height: rows, data: photo.data.subarray(0, photo.width * rows * 4) };
  assert.deepEqual(Reader.read(art).lines, []);
});
