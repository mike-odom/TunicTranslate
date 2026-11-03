#!/usr/bin/env node
'use strict';
// Scores the reader against a book with a known transcription: for every page image that
// has a transcription, how many of the words the reader gives are in the transcription
// (precision), and how many of the transcription's words it gives (recall). Words are
// compared as bags, lower-cased, punctuation stripped, so the order within a page does
// not matter. The transcription also holds words printed in English on the page, which
// the reader does not read, so recall cannot reach 100%; precision can.
//
//   node tools/score_manual.js <pages dir> <transcriptions dir> [--only 20,21] [--show] [--missing]
// --show prints each page's reading and its wrong words; --missing the transcription words it did not give.
//
// Pages are p-NNN.jpg (NNN from 0; the book's page N is p-00N... see pageOf) and
// transcriptions wiki_page-N-*.txt (tunic.wiki plain-text exports), both outside the repo.
const fs = require('node:fs');
const path = require('node:path');
const jpeg = require('jpeg-js');
const Reader = require('../reader.js');

const args = process.argv.slice(2);
const BOOL = { '--show': true, '--missing': true };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, BOOL[name] ? 1 : 2); return BOOL[name] ? true : v; };
const only = (flag('--only') || '').split(',').filter(Boolean).map(Number);
const show = !!flag('--show');
const showMissing = !!flag('--missing');
const [pagesDir, gtDir] = args;
if (!pagesDir || !gtDir) { console.error('usage: node tools/score_manual.js <pages dir> <transcriptions dir> [--only N,N] [--show]'); process.exit(2); }

// The PDF's first image (p-000) is the front cover, so the book's page N is image p-00N.
function pageOf(file) { return Number(file.match(/p-(\d+)/)[1]); }

const PLACE = /^(box|boxes|bubble|banner|caption|edges?|corner|upper|lower|top|bottom|left|right|middle|center|centre|upper-left|upper-right|lower-left|lower-right|top-left|top-right|bottom-left|bottom-right|header|footer|sidebar|panel|column)$/i;
const LAYOUT = /^(upper|lower|top|bottom|left|right|middle|center|centre|side|corner|inner|outer|main|small|large|big|first|second|third|fourth|box|edges?|thought|bubble|text|banner|caption|title|header|panel|page|paragraph|column|row|section|list|table|note|notes|under|above|below|next|to|the|of|and|in|on|a|an|-|&|with|body|image|picture|speech|fox|sign|card|cards|top-left|top-right|bottom-left|bottom-right|upper-left|upper-right|lower-left|lower-right)$/i;

function words(text) {
  return text.toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
}

/** The transcription's words: everything after "Translation", minus the layout headings. */
function transcription(file) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('\nTranslation\n');
  let body = start >= 0 ? text.slice(start + 13) : text;
  const end = body.search(/\n(Elaboration|Notes?|Commentary|Trivia)\n/);   // the wiki's commentary follows the text
  if (end >= 0) body = body.slice(0, end);
  const out = [];
  body.split('\n').forEach((line) => {
    const ws = line.trim().split(/\s+/).filter(Boolean);
    // "Upper-Right Box", "Yellow Thought Bubble", "Middle Left Box": where on the page, not what it says
    if (ws.length && ws.length <= 5 && !/[.!?,]/.test(line) && ws.some((w) => PLACE.test(w))) return;
    if (ws.length && ws.length <= 5 && ws.every((w) => LAYOUT.test(w))) return;
    out.push.apply(out, words(line));
  });
  return out;
}

function bag(ws) { const m = new Map(); ws.forEach((w) => m.set(w, (m.get(w) || 0) + 1)); return m; }

const gtFiles = fs.readdirSync(gtDir).filter((f) => /^wiki_page-\d+-.*\.txt$/.test(f));
const gtByPage = new Map(gtFiles.map((f) => [Number(f.match(/page-(\d+)/)[1]), path.join(gtDir, f)]));
const pages = fs.readdirSync(pagesDir).filter((f) => /^p-\d+\.jpe?g$/.test(f)).sort()
  .filter((f) => gtByPage.has(pageOf(f)) && (!only.length || only.includes(pageOf(f))));

let totals = { gt: 0, read: 0, exact: 0, hit: 0, exactHit: 0, ms: 0 };
console.log('page   gt   read  exact   hit   prec  recall   ms');
for (const file of pages) {
  const n = pageOf(file);
  const gt = transcription(gtByPage.get(n));
  if (!gt.length) continue;
  const img = jpeg.decode(fs.readFileSync(path.join(pagesDir, file)), { useTArray: true, maxMemoryUsageInMB: 2048 });
  const t = Date.now();
  const result = Reader.read(img);
  const ms = Date.now() - t;
  const read = [], exact = [];
  result.lines.forEach((l) => l.words.forEach((w) => { read.push(w.english || '?'); if (w.english && w.cost === 0) exact.push(w.english); }));
  const left = bag(gt);
  let hit = 0, exactHit = 0;
  const missed = [];
  read.forEach((w) => { if (left.get(w) > 0) { hit++; left.set(w, left.get(w) - 1); } else missed.push(w); });
  const left2 = bag(gt);
  exact.forEach((w) => { if (left2.get(w) > 0) { exactHit++; left2.set(w, left2.get(w) - 1); } });
  totals.gt += gt.length; totals.read += read.length; totals.exact += exact.length; totals.hit += hit; totals.exactHit += exactHit; totals.ms += ms;
  const pct = (a, b) => b ? (100 * a / b).toFixed(0).padStart(4) + '%' : '   - ';
  console.log(String(n).padStart(4), String(gt.length).padStart(4), String(read.length).padStart(5), String(exact.length).padStart(6), String(hit).padStart(5), pct(hit, read.length), pct(hit, gt.length), String(ms).padStart(6));
  if (show) {
    result.lines.forEach((l) => console.log('        ' + l.text));
    if (missed.length) console.log('        wrong: ' + missed.join(' '));
  }
  if (showMissing) {
    const notRead = [];
    left.forEach((n, w) => { for (let i = 0; i < n; i++) notRead.push(w); });
    console.log('        missing: ' + notRead.join(' '));
  }
}
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
console.log('total', totals.gt, 'gt words;', totals.read, 'read,', totals.hit, 'right: precision', pct(totals.hit, totals.read) + ', recall', pct(totals.hit, totals.gt) + '; exact words', totals.exact, 'of which right', pct(totals.exactHit, totals.exact) + ';', Math.round(totals.ms / 1000) + 's');
