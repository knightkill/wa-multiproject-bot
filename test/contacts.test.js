import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { openDb } from '../db.js';
import { registerAccountRoutes } from '../src/account-routes.js';
import { readerConfig } from '../routes/reader.js';
import {
  phoneToJid,
  collapseGoogle,
  captureContacts,
  captureLidMappings,
  lidPairsFromKey,
  userJid,
} from '../src/contacts.js';

const ADMIN = 'a'.repeat(64);
const PUSH = 'p'.repeat(64);
const PN = '919099655122@s.whatsapp.net';
const LID = '123456789012345@lid';
const silent = { info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-contacts-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const freshDb = () => openDb(path.join(tmp, `${Math.random().toString(36).slice(2)}.db`));

function build({ pushToken = PUSH, resyncContacts = async () => {} } = {}) {
  const app = new Hono();
  const db = freshDb();
  const projectApp = registerAccountRoutes(app, {
    prefix: '',
    db,
    adminToken: ADMIN,
    reader: readerConfig({ adminToken: ADMIN, logger: silent }),
    getSock: () => null,
    isPaired: () => true,
    getCurrentQR: () => null,
    groupsCache: { get: async () => [], invalidate() {} },
    dmSender: {},
    dmAllowlistEnabled: true,
    saveMedia: async () => null,
    resyncContacts,
    contactsPushToken: pushToken,
    log: silent,
  });
  app.route('/', projectApp);
  return { app, db };
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('phoneToJid', () => {
  test('reads numbers without a country code as Indian', () => {
    assert.equal(phoneToJid('8264747474'), '918264747474@s.whatsapp.net');
    assert.equal(phoneToJid('098250 12345'), '919825012345@s.whatsapp.net');
    assert.equal(phoneToJid('+91 98250 12345'), '919825012345@s.whatsapp.net');
  });
  test('keeps foreign numbers, with or without the +', () => {
    assert.equal(phoneToJid('+61469132160'), '61469132160@s.whatsapp.net');
    assert.equal(phoneToJid('61469132160'), '61469132160@s.whatsapp.net');
  });
  test('rejects junk', () => {
    assert.equal(phoneToJid(''), null);
    assert.equal(phoneToJid('123'), null);
    assert.equal(phoneToJid('n/a'), null);
  });
});

describe('userJid', () => {
  test('strips device suffix and rejects non-person JIDs', () => {
    assert.equal(userJid('919099655122:12@s.whatsapp.net'), PN);
    assert.equal(userJid('123456789012345:3@lid'), LID);
    assert.equal(userJid('120363000000000001@g.us'), null);
    assert.equal(userJid('status@broadcast'), null);
  });
});

describe('collapseGoogle', () => {
  test('duplicates on one number keep the newest name and the rest as aliases', () => {
    const { contacts, skipped } = collapseGoogle([
      { name: 'Aagam Real Estate', phones: ['+91 99090 00185'], updatedAt: '2020-01-01T00:00:00Z' },
      { name: 'Aagam RE', phones: ['9909000185'], updatedAt: '2024-01-01T00:00:00Z' },
      { name: 'aagam re', phones: ['09909000185'] },
      { name: 'No Phone', phones: [] },
      { name: 'Bad', phones: ['12'] },
    ]);
    assert.equal(skipped, 1);
    assert.deepEqual(contacts.get('919909000185@s.whatsapp.net'), {
      name: 'Aagam RE',
      aliases: ['Aagam Real Estate'],
    });
    assert.equal(contacts.size, 1);
  });
});

describe('contacts store', () => {
  test('WhatsApp name beats Google beats pushName', () => {
    const db = freshDb();
    captureContacts(db, [{ id: PN, notify: 'joshil 🙂' }]);
    assert.deepEqual(db.contactNames([PN])[PN], { name: 'joshil 🙂', source: 'pushname' });
    db.replaceGoogleContacts(new Map([[PN, { name: 'Joshil Google', aliases: [] }]]));
    assert.deepEqual(db.contactNames([PN])[PN], { name: 'Joshil Google', source: 'google' });
    captureContacts(db, [{ id: PN, name: 'Joshil' }]);
    assert.deepEqual(db.contactNames([PN])[PN], { name: 'Joshil', source: 'whatsapp' });
  });

  test('a later Google snapshot never touches WhatsApp names and clears dropped Google ones', () => {
    const db = freshDb();
    const other = '919825012345@s.whatsapp.net';
    captureContacts(db, [{ id: PN, name: 'Joshil' }]);
    db.replaceGoogleContacts(new Map([[PN, { name: 'J', aliases: [] }], [other, { name: 'Gone', aliases: [] }]]));
    db.replaceGoogleContacts(new Map());
    const [row] = db.searchContacts({ q: 'joshil' });
    assert.equal(row.whatsappName, 'Joshil');
    assert.equal(row.googleName, null);
    assert.equal(db.searchContacts({ q: 'Gone' }).length, 0);
  });

  test('a LID-keyed contact folds into its phone row once the mapping arrives', () => {
    const db = freshDb();
    captureContacts(db, [{ id: LID, notify: 'Josh' }]);
    db.replaceGoogleContacts(new Map([[PN, { name: 'Joshil G', aliases: ['JP'] }]]));
    captureLidMappings(db, { lid: LID, pn: PN });
    const rows = db.searchContacts({ q: 'jos' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].jid, PN);
    assert.deepEqual(rows[0].lids, [LID]);
    assert.equal(rows[0].pushName, 'Josh');
    assert.equal(rows[0].googleName, 'Joshil G');
    // Later events addressed by LID land on the phone row.
    captureContacts(db, [{ id: LID, name: 'Joshil' }]);
    assert.equal(db.contactNames([LID])[LID].name, 'Joshil');
    assert.equal(db.searchContacts({ q: 'JP' })[0].name, 'Joshil');
  });

  test('contactAction carries both ids: mapping and name are recorded', () => {
    const db = freshDb();
    captureContacts(db, [{ id: PN, name: 'Joshil', lid: LID }]);
    assert.equal(db.contactNames([LID])[LID].name, 'Joshil');
    assert.equal(db.contactCounts().lids, 1);
  });

  test('message keys yield LID ↔ phone pairs', () => {
    assert.deepEqual(lidPairsFromKey({ remoteJid: LID, remoteJidAlt: PN }), [{ lid: LID, pn: PN }]);
    assert.deepEqual(
      lidPairsFromKey({ remoteJid: '120363000000000001@g.us', participant: PN, participantAlt: LID }),
      [{ lid: LID, pn: PN }]
    );
    assert.deepEqual(lidPairsFromKey({ remoteJid: PN }), []);
  });

  test('search escapes LIKE wildcards', () => {
    const db = freshDb();
    captureContacts(db, [{ id: PN, name: 'Joshil' }]);
    assert.equal(db.searchContacts({ q: '%' }).length, 0);
    assert.equal(db.searchContacts({ q: null }).length, 1);
  });
});

describe('HTTP', () => {
  test('Google push needs the push token, not the admin token', async () => {
    const { app } = build();
    const body = JSON.stringify({ contacts: [{ name: 'Joshil', phones: ['9099655122'] }] });
    const put = (h) => app.request('/contacts/google', { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body });
    assert.equal((await put(bearer(ADMIN))).status, 401);
    const res = await put(bearer(PUSH));
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.numbers, 1);
    assert.equal(json.counts.google, 1);
  });

  test('push is off (401) without a token configured', async () => {
    const { app } = build({ pushToken: null });
    const res = await app.request('/contacts/google', {
      method: 'PUT',
      headers: { ...bearer(PUSH), 'Content-Type': 'application/json' },
      body: '{"contacts":[]}',
    });
    assert.equal(res.status, 401);
  });

  test('admin search and inbound names', async () => {
    const { app, db } = build();
    captureContacts(db, [{ id: PN, name: 'Joshil' }]);
    db.insertInboundMessage({ waId: 'w1', chatJid: PN, senderJid: PN, fromMe: false, timestamp: 1000, text: 'hi' });
    assert.equal((await app.request('/admin/api/contacts?q=josh')).status, 401);
    const found = await (await app.request('/admin/api/contacts?q=josh', { headers: bearer(ADMIN) })).json();
    assert.equal(found.contacts[0].jid, PN);
    const inbound = await (await app.request('/admin/api/inbound', { headers: bearer(ADMIN) })).json();
    assert.equal(inbound.messages[0].sender_name, 'Joshil');
    assert.equal(inbound.messages[0].chat_name, 'Joshil');
  });

  test('resync calls the hook and reports counts', async () => {
    let called = 0;
    const { app } = build({ resyncContacts: async () => { called++; } });
    const res = await app.request('/admin/api/contacts/resync', { method: 'POST', headers: bearer(ADMIN) });
    assert.equal(res.status, 200);
    assert.equal(called, 1);
    assert.ok((await res.json()).after);
  });
});
