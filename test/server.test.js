'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server.js');

const CODE = 'open-sesame';

function start(fakeCreate, accessCode = CODE) {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trunic-uploads-'));
  const server = createServer({ client: () => ({ messages: { create: fakeCreate } }), uploadsDir, accessCode });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, uploadsDir, base: 'http://127.0.0.1:' + server.address().port });
  }));
}

const IMAGE = Buffer.from('not-really-a-jpeg').toString('base64');
function post(base, body, code = CODE) {
  const headers = code === null ? {} : { 'X-Access-Code': code };
  return fetch(base + '/api/analyze', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('analyze sends image, reading and notes to Claude, and saves the upload', async () => {
  let seen;
  const { server, uploadsDir, base } = await start(async (params) => {
    seen = params;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Reading looks right.' }] };
  });
  try {
    const reading = [{ text: 'the', phonetic: 'DH-uh', words: [{ english: 'the', spelling: 'dhuh', cost: 0, alternatives: [] }] }];
    const res = await post(base, { imageBase64: IMAGE, mediaType: 'image/jpeg', notes: 'correct, but garbage around it', reading });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.analysis, 'Reading looks right.');

    const content = seen.messages[0].content;
    assert.equal(content[0].source.data, IMAGE);
    assert.match(content[1].text, /correct, but garbage around it/);
    assert.match(content[1].text, /"english": "the"/);

    const dir = path.join(uploadsDir, body.id);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'image.jpg')), Buffer.from(IMAGE, 'base64'));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    assert.equal(meta.notes, 'correct, but garbage around it');
    assert.equal(meta.analysis, 'Reading looks right.');
  } finally { server.close(); }
});

test('analyze rejects bad input without calling Claude or saving', async () => {
  let calls = 0;
  const { server, uploadsDir, base } = await start(async () => { calls++; });
  try {
    assert.equal((await post(base, 'nope')).status, 400);
    assert.equal((await post(base, { imageBase64: IMAGE, mediaType: 'image/tiff' })).status, 400);
    assert.equal((await post(base, { imageBase64: '../../x', mediaType: 'image/jpeg' })).status, 400);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(uploadsDir), []);
  } finally { server.close(); }
});

test('Claude failures surface as errors and nothing is saved', async () => {
  const { server, uploadsDir, base } = await start(async () => {
    throw Object.assign(new Error('rate'), { status: 429 });
  });
  try {
    const res = await post(base, { imageBase64: IMAGE, mediaType: 'image/png' });
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /rate limited/);
    assert.deepEqual(fs.readdirSync(uploadsDir), []);
  } finally { server.close(); }
});

test('static files are served but server code and uploads are not', async () => {
  const { server, base } = await start(async () => {});
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/app.js')).status, 200);
    assert.equal((await fetch(base + '/server.js')).status, 404);
    assert.equal((await fetch(base + '/uploads/x/meta.json')).status, 404);
    assert.equal((await fetch(base + '/package.json')).status, 404);
  } finally { server.close(); }
});

test('analyze needs the access code, and is off when none is configured', async () => {
  let calls = 0;
  const create = async () => { calls++; return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }; };
  const body = { imageBase64: IMAGE, mediaType: 'image/jpeg' };

  const guarded = await start(create);
  try {
    const missing = await post(guarded.base, body, null);
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).needsCode, true);
    const wrong = await post(guarded.base, body, 'open-sesamE');
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json()).needsCode, true);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(guarded.uploadsDir), []);
  } finally { guarded.server.close(); }

  const unconfigured = await start(create, null);
  try {
    const res = await post(unconfigured.base, body, '');
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /TRUNIC_ACCESS_CODE/);
    assert.equal(calls, 0);
  } finally { unconfigured.server.close(); }
});
