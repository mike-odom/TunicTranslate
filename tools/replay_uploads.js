#!/usr/bin/env node
'use strict';
// Re-reads every picture saved by "Upload and analyze" (uploads/<id>/) with the current
// engine and shows it next to what the app read at upload time and the user's notes, so
// engine changes can be judged against real photos.
//
//   node tools/replay_uploads.js            all uploads
//   node tools/replay_uploads.js <id>...    just these (a prefix of the folder name is enough)
//   node tools/replay_uploads.js --debugX
//
// A photo whose correct reading is known (for example the card's English caption sits next
// to the runes) can become a regression test: copy its image.jpg into
// test/fixtures/photos/<name>/ with an expected.json (see test/photos.test.js).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const jpeg = require('jpeg-js');
const Reader = require('../reader.js');

const UPLOADS = path.join(__dirname, '..', 'uploads');
const args = process.argv.slice(2);
const debug = args.includes('--debug');
const wanted = args.filter((a) => !a.startsWith('--'));
if (!fs.existsSync(UPLOADS)) { console.log('No uploads yet (' + UPLOADS + ').'); process.exit(0); }

const ids = fs.readdirSync(UPLOADS).filter((id) => fs.existsSync(path.join(UPLOADS, id, 'meta.json')))
  .filter((id) => !wanted.length || wanted.some((w) => id.startsWith(w))).sort();

for (const id of ids) {
  const dir = path.join(UPLOADS, id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const file = fs.readdirSync(dir).find((f) => /^image\./.test(f));
  console.log('\n== ' + id + '  (' + file + ')');
  if (meta.notes) console.log('notes:    ' + meta.notes.replace(/\n/g, ' '));
  const then = (meta.reading || []).map((l) => l.text);
  console.log('then:     ' + (then.length ? then.join(' / ') : '(nothing)'));
  if (meta.engine && meta.engine.factor) console.log('then via: ' + JSON.stringify(meta.engine));
  if (!/\.jpe?g$/.test(file)) { console.log('now:      (only JPEG uploads can be replayed)'); continue; }

  const img = jpeg.decode(fs.readFileSync(path.join(dir, file)), { useTArray: true });
  const t = Date.now();
  const result = Reader.read(img);
  const now = result.lines.map((l) => l.text);
  console.log('now:      ' + (now.length ? now.join(' / ') : '(nothing)'));
  console.log('now via:  factor ' + result.factor + ', ' + result.reading.method + ', skew ' +
    (result.reading.skew ? (result.reading.skew * 180 / Math.PI).toFixed(1) + ' deg' : 'none') +
    ', glyph ' + (result.reading.glyphHeight || 0).toFixed(0) + ' px, exact score ' + result.exact.toFixed(1) + ', ' + (Date.now() - t) + ' ms');
  console.log('changed:  ' + (JSON.stringify(then) === JSON.stringify(now) ? 'no' : 'yes'));
  if (debug) {
    const out = path.join(process.env.TMPDIR || '/tmp', id + '.debug.png');
    spawnSync(process.execPath, [path.join(__dirname, 'debug_image.js'), path.join(dir, file), out, '--scale', String(result.factor)], { stdio: 'ignore' });
    console.log('overlay:  ' + out);
  }
}
if (!ids.length) console.log('No matching uploads.');
