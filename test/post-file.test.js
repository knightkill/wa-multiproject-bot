import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { createProjectApp } from '../routes/project.js';

const GROUP = '120363000000000001@g.us';
const OTHER = '120363000000000002@g.us';
const silent = { info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-post-file-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// GROUP is allowlisted and in the project; OTHER is allowlisted but not in the
// project, so the two 403 paths can be told apart.
function build({ allowlist = [GROUP, OTHER] } = {}) {
  const db = openDb(path.join(tmp, `${Math.random().toString(36).slice(2)}.db`));
  const sent = [];
  const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return {}; } };
  db.setAllowedGroups(allowlist);
  const { token } = db.createProject('receipts', allowlist.includes(GROUP) ? [GROUP] : []);
  const app = createProjectApp({
    db,
    getSock: () => sock,
    isPaired: () => true,
    groupsCache: { get: async () => [], invalidate() {} },
    logger: silent,
    dmSender: {},
    dmAllowlistEnabled: true,
  });
  const post = (body) =>
    app.request('/v1/post/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  return { db, sent, post };
}

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const png = { data: PNG.toString('base64'), mimetype: 'image/png' };

describe('POST /v1/post/file', () => {
  test('image posts alone, with no text card, and is logged without the file', async () => {
    const { db, sent, post } = build();
    const res = await post({ groupJid: GROUP, media: png });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, GROUP);
    assert.deepEqual(sent[0].content.image, PNG);
    assert.equal(sent[0].content.caption, undefined);
    const [row] = db.listMessages({ limit: 1 });
    assert.equal(row.status, 'sent');
    assert.equal(row.title, '[image]');
  });

  test('caption is passed through', async () => {
    const { sent, post } = build();
    const res = await post({ groupJid: GROUP, media: png, caption: 'receipt' });
    assert.equal(res.status, 200);
    assert.equal(sent[0].content.caption, 'receipt');
  });

  test('PDF posts as a document', async () => {
    const { sent, post } = build();
    const res = await post({
      groupJid: GROUP,
      media: { data: Buffer.from('%PDF-1.4').toString('base64'), mimetype: 'application/pdf', filename: 'r.pdf' },
    });
    assert.equal(res.status, 200);
    assert.equal(sent[0].content.fileName, 'r.pdf');
    assert.ok(Buffer.isBuffer(sent[0].content.document));
  });

  test('group outside the project is refused', async () => {
    const { sent, post } = build();
    const res = await post({ groupJid: OTHER, media: png });
    assert.equal(res.status, 403);
    assert.equal(sent.length, 0);
  });

  test('group dropped from the global allowlist is refused', async () => {
    const { db, sent, post } = build();
    db.setAllowedGroups([OTHER]);
    const res = await post({ groupJid: GROUP, media: png });
    assert.equal(res.status, 403);
    assert.equal(sent.length, 0);
  });

  test('unsupported type and oversized file are refused', async () => {
    const { sent, post } = build();
    assert.equal((await post({ groupJid: GROUP, media: { ...png, mimetype: 'video/mp4' } })).status, 400);
    const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    assert.equal((await post({ groupJid: GROUP, media: { data: big, mimetype: 'image/png' } })).status, 400);
    assert.equal(sent.length, 0);
  });
});
