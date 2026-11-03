'use strict';
// Static file server plus POST /api/analyze: saves an uploaded picture with the
// user's notes and the app's own reading, and asks Claude to review the reading.
// Run with `npm start` (needs ANTHROPIC_API_KEY, or an `ant auth login` profile).

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const MODEL = process.env.TRUNIC_MODEL || 'claude-opus-5-5';
const MAX_BODY = 20 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};
// Files served to the browser; keeps uploads/, node_modules/ and server code private.
const PUBLIC = /^\/(?:|index\.html|[\w-]+\.(?:js|css|svg|png|webmanifest))$/;
const PRIVATE = new Set(['/server.js']);

const SYSTEM = [
  'You help improve a Trunic reader. Trunic is the invented script from the game Tunic: each glyph is one',
  'syllable, drawn as a vowel half (outer lines) and a consonant half (inner lines around a horizontal bar);',
  'a circle under a glyph means the vowel is read first. A word is a run of glyphs joined along their bars.',
  '',
  'You cannot reliably read individual runes from a picture, and the user knows that. Do not translate them,',
  'and do not tell the user to take a better photo as the whole answer: the reader is what has to improve.',
  'What you can judge reliably is the picture and the layout, and the reader\'s engineers need exactly that.',
  '',
  'You get the picture, what the reader produced (per line: English guess, Trunic spelling, per-word match',
  'cost: 0 is an exact dictionary match, higher a loose guess, null unreadable), diagnostics about how it',
  'read the picture, and the user\'s notes. Treat the notes as ground truth over your own impressions.',
  '',
  'Reply in plain text, under 200 words, in these parts:',
  'LAYOUT: how many lines of runes you see, and how many rune words on each (separate words by the gaps).',
  '  Say where the English captions, headings, borders and other non-rune marks are.',
  'PICTURE: tilt, perspective, blur, glare, moire from photographing a screen, low resolution, anything',
  '  covering the text; roughly how tall one rune is in pixels.',
  'READER vs PICTURE: does the number of lines and words the reader found match yours? Name the lines or words',
  '  it missed, merged, split or invented (marks that are not rune words).',
  'NEXT: one or two concrete things that would most improve the reader on a picture like this.'
].join('\n');

function buildContent({ imageBase64, mediaType, notes, reading, engine }) {
  const text = [
    'The app read this picture as:',
    JSON.stringify(reading, null, 2),
    '',
    'How it read it (image size, enlargement tried, threshold, tilt corrected, glyph height in px):',
    JSON.stringify(engine),
    '',
    notes ? 'User notes:\n' + notes : 'The user left no notes.'
  ].join('\n');
  return [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
    { type: 'text', text }
  ];
}

// Returns the cleaned request, or throws an Error with a `status`.
function parseRequest(raw) {
  function bad(message) { return Object.assign(new Error(message), { status: 400 }); }
  var body;
  try { body = JSON.parse(raw); } catch (e) { throw bad('The request was not valid JSON.'); }
  if (!body || typeof body !== 'object') throw bad('The request body must be an object.');
  var mediaType = body.mediaType;
  if (!IMAGE_TYPES[mediaType]) throw bad('Unsupported image type.');
  if (typeof body.imageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.imageBase64)) {
    throw bad('The image must be base64 data.');
  }
  return {
    imageBase64: body.imageBase64,
    mediaType: mediaType,
    notes: typeof body.notes === 'string' ? body.notes.slice(0, 5000).trim() : '',
    reading: Array.isArray(body.reading) ? body.reading : [],
    engine: body.engine && typeof body.engine === 'object' && !Array.isArray(body.engine) && JSON.stringify(body.engine).length < 2000
      ? body.engine : {}
  };
}

async function analyze(client, req, uploadsDir) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: 'user', content: buildContent(req) }]
  });
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined to analyze this image.'), { status: 422 });
  const analysis = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

  // Keep every upload with its notes, reading and analysis; they make good test fixtures.
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(uploadsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'image.' + IMAGE_TYPES[req.mediaType]), Buffer.from(req.imageBase64, 'base64'));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    model: MODEL, notes: req.notes, reading: req.reading, engine: req.engine, analysis: analysis
  }, null, 2));
  return { id: id, analysis: analysis };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    var size = 0, chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('That upload is too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// The app is reachable on the public internet through a tunnel, and every analysis
// spends the owner's API credit, so the endpoint needs a shared access code. With no
// code configured it refuses, rather than defaulting to open.
function checkAccess(req, accessCode) {
  if (!accessCode) return { status: 403, error: 'Analysis is switched off: set TRUNIC_ACCESS_CODE on the server.' };
  const sent = String(req.headers['x-access-code'] || '');
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  if (!crypto.timingSafeEqual(digest(sent), digest(accessCode))) {
    return { status: 403, error: sent ? 'That access code is wrong.' : 'Enter the access code.', needsCode: true };
  }
  return null;
}

function createServer(options) {
  const client = options.client;
  const uploadsDir = options.uploadsDir || path.join(ROOT, 'uploads');
  const accessCode = options.accessCode;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/analyze') {
        if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
        const denied = checkAccess(req, accessCode);
        if (denied) { req.resume(); return send(res, denied.status, { error: denied.error, needsCode: !!denied.needsCode }); }
        const parsed = parseRequest(await readBody(req));
        return send(res, 200, await analyze(client(), parsed, uploadsDir));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Use GET.' });
      if (!PUBLIC.test(url.pathname) || PRIVATE.has(url.pathname)) return send(res, 404, 'Not found', 'text/plain');
      const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
      fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, 'Not found', 'text/plain');
        send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
      });
    } catch (e) {
      // Anthropic.APIError carries `status`; anything else is a server fault.
      // With no key at all the SDK throws a plain Error before any request is made.
      const noCredentials = !Number.isInteger(e.status) && /authentication method/i.test(e.message);
      const status = noCredentials ? 401 : Number.isInteger(e.status) ? e.status : 500;
      const message = status === 401 ? 'The server has no valid Anthropic credentials. Set ANTHROPIC_API_KEY and restart it.'
        : status === 429 ? 'Claude is rate limited right now. Try again shortly.'
        : status >= 500 && !e.expose ? 'The analysis failed on the server.' : e.message;
      if (status >= 500 || status === 401) console.error(e);
      send(res, status >= 400 && status < 600 ? status : 500, { error: message });
    }
  });
}

module.exports = { createServer, parseRequest, buildContent };

if (require.main === module) {
  const Anthropic = require('@anthropic-ai/sdk');
  let instance;
  const port = Number(process.env.PORT) || 8080;
  const accessCode = process.env.TRUNIC_ACCESS_CODE;
  createServer({ client: () => (instance = instance || new Anthropic()), accessCode })
    .listen(port, () => {
      console.log('Trunic Translator on http://localhost:' + port + ' (model ' + MODEL + ')');
      if (!accessCode) console.warn('TRUNIC_ACCESS_CODE is not set: "Upload and analyze" is switched off.');
    });
}
