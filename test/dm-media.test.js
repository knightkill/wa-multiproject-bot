import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { createDmSender } from '../src/dmQueue.js';
import { createProjectApp } from '../routes/project.js';

const ALLOWED = '919999999999@s.whatsapp.net';
const DENIED = '918888888888@s.whatsapp.net';
const silent = { info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dm-media-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Real DM sender and route against a fake socket that records what it was
// asked to send. Caps are lifted so each test can send without waiting.
function build() {
  const db = openDb(path.join(tmp, `${Math.random().toString(36).slice(2)}.db`));
  const sent = [];
  const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return {}; } };
  const dmSender = createDmSender({
    db,
    getSock: () => sock,
    isPaired: () => true,
    logger: silent,
    config: { capPerMin: 100, capPerDay: 100 },
  });
  const app = createProjectApp({
    db,
    getSock: () => sock,
    isPaired: () => true,
    groupsCache: { get: async () => [], invalidate() {} },
    logger: silent,
    dmSender,
    dmAllowlistEnabled: true,
  });
  db.setDmAllowed([ALLOWED]);
  const { token } = db.createProject('t', []);
  const post = (body) =>
    app.request('/v1/dm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  return { db, sent, post };
}

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');

describe('POST /v1/dm media', () => {
  test('text-only DM is unchanged', async () => {
    const { sent, post } = build();
    const res = await post({ toJid: ALLOWED, text: 'hi' });
    assert.equal(res.status, 200);
    assert.deepEqual(sent[0].content, { text: 'hi' });
  });

  test('image with caption sends as image; queue row holds no file data', async () => {
    const { db, sent, post } = build();
    const res = await post({
      toJid: ALLOWED,
      text: 'receipt',
      media: { data: PNG.toString('base64'), mimetype: 'image/png' },
    });
    assert.equal(res.status, 200);
    assert.ok(Buffer.isBuffer(sent[0].content.image));
    assert.deepEqual(sent[0].content.image, PNG);
    assert.equal(sent[0].content.caption, 'receipt');
    const [row] = db.listDmQueue({ limit: 1 });
    assert.equal(row.body, '[image] receipt');
  });

  test('image without text is allowed', async () => {
    const { sent, post } = build();
    const res = await post({ toJid: ALLOWED, media: { data: PNG.toString('base64'), mimetype: 'image/png' } });
    assert.equal(res.status, 200);
    assert.equal(sent[0].content.caption, undefined);
  });

  test('PDF sends as a document with its filename', async () => {
    const { sent, post } = build();
    const res = await post({
      toJid: ALLOWED,
      media: { data: Buffer.from('%PDF-1.4').toString('base64'), mimetype: 'application/pdf', filename: 'r.pdf' },
    });
    assert.equal(res.status, 200);
    assert.equal(sent[0].content.fileName, 'r.pdf');
    assert.equal(sent[0].content.mimetype, 'application/pdf');
    assert.ok(Buffer.isBuffer(sent[0].content.document));
  });

  test('neither text nor media is rejected', async () => {
    const { sent, post } = build();
    const res = await post({ toJid: ALLOWED });
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  });

  test('unsupported mimetype is rejected', async () => {
    const { sent, post } = build();
    const res = await post({ toJid: ALLOWED, media: { data: PNG.toString('base64'), mimetype: 'video/mp4' } });
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  });

  test('over 5 MB is rejected', async () => {
    const { sent, post } = build();
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    const res = await post({ toJid: ALLOWED, media: { data: big, mimetype: 'image/png' } });
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
  });

  test('allowlist still applies to media', async () => {
    const { sent, post } = build();
    const res = await post({ toJid: DENIED, media: { data: PNG.toString('base64'), mimetype: 'image/png' } });
    assert.equal(res.status, 403);
    assert.equal(sent.length, 0);
  });
});
