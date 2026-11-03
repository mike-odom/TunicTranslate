#!/usr/bin/env node
'use strict';
// Reads every JPEG in a folder with the app's reader and writes one JSON line per page:
// the English lines, how many words matched the dictionary exactly, and the time taken.
// Used to see how the engine does on a whole book (the Tunic manual, extracted with
// `pdfimages -j manual.pdf pages/p`).
//
//   node tools/read_pages.js <folder> [out.jsonl]
const fs = require('node:fs');
const path = require('node:path');
const jpeg = require('jpeg-js');
const Reader = require('../reader.js');

const [dir, outFile] = process.argv.slice(2);
if (!dir) { console.error('usage: node tools/read_pages.js <folder of jpegs> [out.jsonl]'); process.exit(2); }
const files = fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();
const out = outFile ? fs.createWriteStream(outFile) : null;

for (const file of files) {
  const img = jpeg.decode(fs.readFileSync(path.join(dir, file)), { useTArray: true, maxMemoryUsageInMB: 1024 });
  const t = Date.now();
  const r = Reader.read(img);
  const words = r.lines.flatMap((l) => l.words);
  const row = {
    page: file, ms: Date.now() - t, factor: r.factor,
    lines: r.lines.length, words: words.length,
    exact: words.filter((w) => w.english && w.cost === 0).length,
    guessed: words.filter((w) => w.english && w.cost > 0).length,
    unreadable: words.filter((w) => !w.english).length,
    text: r.lines.map((l) => l.text)
  };
  if (out) out.write(JSON.stringify(row) + '\n');
  console.log(file, row.ms + 'ms', row.lines + ' lines', row.words + ' words', row.exact + ' exact');
}
if (out) out.end();
