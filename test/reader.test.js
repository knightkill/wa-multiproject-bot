import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { openDb } from '../db.js';
import { registerAccountRoutes } from '../src/account-routes.js';
import { readerConfig } from '../routes/reader.js';

const ADMIN = 'a'.repeat(64);
const READER = 'r'.repeat(64);
const ALLOWED = '120363000000000001@g.us';
const ALLOWED_DM = '919999999999@s.whatsapp.net';
const DENIED = '120363000000000002@g.us';
const silent = { info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reader-test-'));
const mediaFile = path.join(tmp, 'm.jpg');
fs.writeFileSync(mediaFile, Buffer.from('JPEGDATA'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Mirrors index.js: per-account routes, then project apps mounted last.
function build({ readerToken = READER, readerChats = `${ALLOWED}, ${ALLOWED_DM}` } = {}) {
  const reader = readerConfig({ readerToken, readerChats, adminToken: ADMIN, logger: silent });
  const app = new Hono();
  const dbs = {};
  const projectApps = [];
  for (const [name, prefix] of [['root', ''], ['ops', '/a/ops']]) {
    const dbPath = path.join(tmp, `${name}-${Math.random().toString(36).slice(2)}.db`);
    const db = openDb(dbPath);
    dbs[name] = db;
    const projectApp = registerAccountRoutes(app, {
      prefix,
      db,
      adminToken: ADMIN,
      reader,
      getSock: () => null,
      isPaired: () => false,
      getCurrentQR: () => 'qr-payload',
      groupsCache: { get: async () => [], invalidate() {} },
      dmSender: {},
      dmAllowlistEnabled: true,
      saveMedia: async (id) => ({ ...db.getInboundMedia(id), path: mediaFile }),
      log: silent,
    });
    projectApps.push({ prefix, projectApp });
  }
  for (const { prefix, projectApp } of projectApps.reverse()) app.route(prefix || '/', projectApp);
  return { app, dbs, reader };
}

function seed(db) {
  const ids = {};
  const rows = [
    ['a1', ALLOWED, 1_000, 'allowed old', null],
    ['a2', ALLOWED, 5_000, 'allowed new', 'image'],
    ['d1', ALLOWED_DM, 3_000, 'allowed dm', null],
    ['x1', DENIED, 4_000, 'denied', 'image'],
    ['x2', DENIED, 6_000, 'denied new', null],
  ];
  for (const [waId, chatJid, timestamp, text, mediaType] of rows) {
    ids[waId] = db.insertInboundMessage({
      waId, chatJid, timestamp, text, mediaType, fromMe: false, mime: mediaType ? 'image/jpeg' : null,
    });
  }
  return ids;
}

const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

describe('reader token tier', () => {
  let app, dbs, ids;
  before(() => {
    ({ app, dbs } = build());
    ids = seed(dbs.root);
    seed(dbs.ops);
  });

  test('200 on an allowed chat', async () => {
    const res = await app.request(`/read/inbound?jid=${encodeURIComponent(ALLOWED)}`, auth(READER));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.messages.map((m) => m.text), ['allowed new', 'allowed old']);
    assert.equal(body.nextCursor, Math.max(ids.a1, ids.a2));
  });

  test('no jid filter returns only allowlisted chats, limit counts allowed rows', async () => {
    const res = await app.request('/read/inbound?limit=3', auth(READER));
    const body = await res.json();
    assert.deepEqual(body.messages.map((m) => m.text), ['allowed new', 'allowed dm', 'allowed old']);
    assert.ok(body.messages.every((m) => m.chat_jid !== DENIED));
  });

  test('disallowed jid gives an empty 200', async () => {
    const res = await app.request(`/read/inbound?jid=${encodeURIComponent(DENIED)}`, auth(READER));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { messages: [], nextCursor: null });
  });

  test('sinceTs filters on send time (inclusive)', async () => {
    const res = await app.request('/read/inbound?sinceTs=3000', auth(READER));
    const body = await res.json();
    assert.deepEqual(body.messages.map((m) => m.text), ['allowed new', 'allowed dm']);
  });

  test('since cursor behaves as on the admin route', async () => {
    const res = await app.request(`/read/inbound?since=${ids.a2}`, auth(READER));
    const body = await res.json();
    assert.deepEqual(body.messages.map((m) => m.text), ['allowed dm']);
  });

  test('works under an extra account prefix', async () => {
    const res = await app.request('/a/ops/read/inbound', auth(READER));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).messages.length, 3);
  });

  test('media: 200 for allowed chat, 404 for disallowed chat or missing', async () => {
    const ok = await app.request(`/read/inbound/${ids.a2}/media`, auth(READER));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/jpeg');
    assert.equal(await ok.text(), 'JPEGDATA');
    const denied = await app.request(`/read/inbound/${ids.x1}/media`, auth(READER));
    assert.equal(denied.status, 404);
    const missing = await app.request('/read/inbound/99999/media', auth(READER));
    assert.equal(missing.status, 404);
    const bad = await app.request('/read/inbound/abc/media', auth(READER));
    assert.equal(bad.status, 400);
  });

  test('reader token is rejected on every other route', async () => {
    const json = (method, body) => ({
      method,
      headers: { Authorization: `Bearer ${READER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const cases = [
      ['/admin/api/inbound', auth(READER)],
      [`/admin/api/inbound/${ids.a2}/media`, auth(READER)],
      ['/admin/api/readable-chats', json('PUT', { chats: [] })],
      ['/admin/api/projects', auth(READER)],
      ['/admin/openapi.json', auth(READER)],
      ['/v1/post', json('POST', { groupJid: ALLOWED, text: 'hi' })],
      ['/v1/dm', json('POST', { to: '919999999999', text: 'hi' })],
      ['/v1/groups', auth(READER)],
      ['/qr', auth(READER)],
      ['/pairing-code', json('POST', { phone: '919999999999' })],
      ['/a/ops/admin/api/inbound', auth(READER)],
      ['/a/ops/qr', auth(READER)],
      ['/a/ops/v1/post', json('POST', { groupJid: ALLOWED, text: 'hi' })],
    ];
    for (const [url, init] of cases) {
      const res = await app.request(url, init);
      assert.equal(res.status, 401, `${init.method ?? 'GET'} ${url} returned ${res.status}`);
    }
    // Readable-chats must be untouched.
    assert.equal(dbs.root.listReadableChats().length, 0);
  });

  test('admin token is rejected on /read/*', async () => {
    for (const url of ['/read/inbound', `/read/inbound/${ids.a2}/media`, '/a/ops/read/inbound']) {
      const res = await app.request(url, auth(ADMIN));
      assert.equal(res.status, 401, url);
    }
  });

  test('token in query string is not accepted', async () => {
    const res = await app.request(`/read/inbound?token=${READER}&access_token=${READER}`);
    assert.equal(res.status, 401);
  });

  test('admin token still works on admin inbound (unrestricted)', async () => {
    const res = await app.request('/admin/api/inbound', auth(ADMIN));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).messages.length, 5);
  });
});

describe('reader feature off', () => {
  for (const [label, opts] of [
    ['READER_TOKEN unset', { readerToken: null }],
    ['READER_TOKEN too short', { readerToken: 'short-token' }],
    ['READER_TOKEN equals ADMIN_TOKEN', { readerToken: ADMIN }],
  ]) {
    test(label, async () => {
      const { app, dbs, reader } = build(opts);
      seed(dbs.root);
      assert.equal(reader.enabled, false);
      for (const t of [READER, ADMIN, 'short-token']) {
        const res = await app.request('/read/inbound', auth(t));
        assert.equal(res.status, 401, `token ${t.slice(0, 5)}…`);
      }
      const media = await app.request('/read/inbound/1/media', auth(opts.readerToken ?? READER));
      assert.equal(media.status, 401);
    });
  }

  test('empty READER_CHATS returns nothing', async () => {
    const { app, dbs } = build({ readerChats: '' });
    seed(dbs.root);
    const res = await app.request('/read/inbound', auth(READER));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { messages: [], nextCursor: null });
  });
});
