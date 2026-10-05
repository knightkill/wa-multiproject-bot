import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  BufferJSON,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { bearerMatches } from './src/auth.js';
import { rateLimit } from './src/rate-limit.js';
import { createDmSender } from './src/dmQueue.js';
import { normalizeInbound } from './src/inbound.js';
import { registerAccountRoutes } from './src/account-routes.js';
import { readerConfig } from './routes/reader.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const AUTH_DIR = process.env.AUTH_DIR ?? '/data/auth-state';
const DB_PATH = process.env.DB_PATH ?? '/data/wp.db';
const DEFAULT_ACCOUNT = process.env.DEFAULT_ACCOUNT ?? 'default';
const PORT = Number(process.env.PORT ?? 8080);
// Extra WhatsApp numbers run alongside the original one in the same process.
// ACCOUNTS="ops,shop" gives each name its own auth state + database under
// /data/accounts/<name>/, served under /a/<name>/ (and /a/<name>/admin). The
// original account keeps AUTH_DIR/DB_PATH and the root paths, untouched.
const ACCOUNTS_DIR = process.env.ACCOUNTS_DIR ?? '/data/accounts';
// Media from live messages is saved as it arrives, because WhatsApp's CDN
// copy expires; history-sync media is only fetched on request (bulk-saving
// a whole history would fill the volume). Video is on-request only.
const MEDIA_SAVE_TYPES = new Set(
  (process.env.MEDIA_SAVE_TYPES ?? 'image,document,audio').split(',').map((t) => t.trim())
);
const MEDIA_MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES ?? 25 * 1024 * 1024);
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
};
const EXTRA_ACCOUNTS = (process.env.ACCOUNTS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

if (!ADMIN_TOKEN) {
  logger.fatal('ADMIN_TOKEN env var required — refusing to start');
  process.exit(1);
}

// DM recipient allowlist (the WA-3 403 gate) is ON by default. Set
// DM_ALLOWLIST_ENABLED=false to bypass it so DMs can go to any recipient
// (caps + jitter + restriction auto-pause still apply). Operator opt-out.
const dmAllowlistEnabled = process.env.DM_ALLOWLIST_ENABLED !== 'false';
if (!dmAllowlistEnabled) {
  logger.warn('DM allowlist DISABLED (DM_ALLOWLIST_ENABLED=false) — DMs may target any recipient; caps/jitter/auto-pause still enforced');
}

// Read-only, chat-scoped token tier. READER_CHATS applies to every account:
// a JID only matches in the account whose database captured it.
const reader = readerConfig({
  readerToken: process.env.READER_TOKEN,
  readerChats: process.env.READER_CHATS,
  adminToken: ADMIN_TOKEN,
  logger,
});

const app = new Hono();
const accounts = [];

// One WhatsApp number: its own Baileys socket, auth state, database, DM
// sender and group cache, mounted under `prefix` ('' for the original).
function createAccount({ name, authDir, dbPath, prefix }) {
  const log = logger.child({ account: name });
  const mediaDir = path.join(path.dirname(dbPath), 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const db = openDb(dbPath);
  log.info({ path: dbPath }, 'db ready');

  let sock = null;
  let currentQR = null;
  let paired = false;

  // 1:1 DM sender with server-side safeguards (jitter + caps + allowlist gate).
  // Recommended distribution path remains invite-link group posts (WA-1); DM is
  // opt-in / low-volume only. Boot is not blocked on this.
  const dmSender = createDmSender({
    db,
    getSock: () => sock,
    isPaired: () => paired,
    logger: log,
  });
  dmSender.start();

  // Download one captured message's media to mediaDir and record the path.
  // Throws when WhatsApp no longer has the file and cannot re-upload it.
  async function saveMedia(id) {
    const media = db.getInboundMedia(id);
    if (!media) throw new Error('no media on this message');
    if (media.path && fs.existsSync(media.path)) return media;
    if (!media.raw) throw new Error('media captured before download support (2026-10-04); cannot be fetched');
    if (!sock) throw new Error('not connected');
    const waMsg = JSON.parse(media.raw, BufferJSON.reviver);
    const buf = await downloadMediaMessage(
      waMsg,
      'buffer',
      {},
      { logger: log, reuploadRequest: sock.updateMediaMessage }
    );
    if (buf.length > MEDIA_MAX_BYTES) throw new Error(`media is ${buf.length} bytes, over MEDIA_MAX_BYTES`);
    const ext = MIME_EXT[(media.mime ?? '').split(';')[0]] ?? 'bin';
    const filePath = path.join(mediaDir, `${id}.${ext}`);
    fs.writeFileSync(filePath, buf);
    db.setInboundMediaPath(id, filePath);
    return { ...media, path: filePath };
  }

  async function start() {
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: log,
      printQRInTerminal: false,
      syncFullHistory: true,
      // Baileys' own default excludes the FULL sync type from processing —
      // without this override, syncFullHistory:true requests the payload
      // but the library silently drops it before messaging-history.set fires.
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        log.info(`QR refreshed — browse to GET ${prefix}/qr to scan`);
      }

      if (connection === 'open') {
        paired = true;
        currentQR = null;
        log.info('connected to WhatsApp');
      }

      if (connection === 'close') {
        paired = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        log.warn({ statusCode, loggedOut }, 'connection closed');
        if (!loggedOut) {
          setTimeout(() => start().catch((e) => log.error(e, 'reconnect failed')), 2000);
        } else if (!state.creds.registered) {
          // A pairing attempt that never completed (an unused pairing code
          // leaves creds.me set, so the next connect tries to log in and is
          // refused). Nothing to lose: wipe and go back to waiting for a link.
          log.warn('unfinished pairing rejected — resetting auth state for a fresh QR');
          fs.rmSync(authDir, { recursive: true, force: true });
          setTimeout(() => start().catch((e) => log.error(e, 'restart failed')), 2000);
        } else {
          log.fatal(`logged out — clear ${authDir} and re-pair via ${prefix}/qr`);
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' || !messages?.length) return;
      for (const message of messages) {
        try {
          const chatJid = message?.key?.remoteJid;
          if (!chatJid || !db.isReadableChat(chatJid)) continue;
          const row = normalizeInbound(message);
          if (!row) continue;
          const id = db.insertInboundMessage(row);
          if (id && row.mediaType && MEDIA_SAVE_TYPES.has(row.mediaType)) {
            saveMedia(id).catch((err) => log.warn({ err: String(err?.message ?? err), id }, 'media save failed'));
          }
        } catch (err) {
          log.warn({ err, id: message?.key?.id }, 'inbound capture failed');
        }
      }
    });

    // WhatsApp pushes prior chat history only around a fresh pairing
    // (first connection with new creds), streamed as one or more
    // messaging-history.set chunks. Same readable-chats gate and
    // normalizer as live capture; INSERT OR IGNORE on (wa_id, chat_jid)
    // makes this safe to overlap with messages.upsert and across chunks.
    sock.ev.on('messaging-history.set', ({ messages, syncType, isLatest, progress }) => {
      log.info({ syncType, isLatest, progress, count: messages?.length ?? 0 }, 'history sync chunk received');
      if (!messages?.length) return;
      let stored = 0;
      for (const message of messages) {
        try {
          const chatJid = message?.key?.remoteJid;
          if (!chatJid || !db.isReadableChat(chatJid)) continue;
          const row = normalizeInbound(message);
          if (!row) continue;
          if (db.insertInboundMessage(row)) stored++;
        } catch (err) {
          log.warn({ err, id: message?.key?.id }, 'history capture failed');
        }
      }
      log.info({ stored }, 'history sync chunk processed');
    });
  }

  start().catch((e) => {
    log.fatal(e, 'baileys start failed');
    process.exit(1);
  });

  const groupsCache = (() => {
    const TTL_MS = 60_000;
    let value = null;
    let fetchedAt = 0;
    let inflight = null;
    return {
      async get() {
        const now = Date.now();
        if (value && now - fetchedAt < TTL_MS) return value;
        if (inflight) return inflight;
        inflight = (async () => {
          const raw = await sock.groupFetchAllParticipating();
          value = Object.values(raw).map((group) => ({ jid: group.id, subject: group.subject }));
          fetchedAt = Date.now();
          inflight = null;
          return value;
        })();
        return inflight;
      },
      invalidate() {
        value = null;
        fetchedAt = 0;
      },
    };
  })();

  const projectApp = registerAccountRoutes(app, {
    prefix,
    db,
    adminToken: ADMIN_TOKEN,
    reader,
    getSock: () => sock,
    isPaired: () => paired,
    getCurrentQR: () => currentQR,
    groupsCache,
    dmSender,
    dmAllowlistEnabled,
    saveMedia,
    log,
  });

  accounts.push({
    name,
    prefix,
    status: () => ({ name, prefix: prefix || '/', paired, me: sock?.user?.id ?? null }),
    projectApp,
  });
}

createAccount({ name: DEFAULT_ACCOUNT, authDir: AUTH_DIR, dbPath: DB_PATH, prefix: '' });
for (const name of EXTRA_ACCOUNTS) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name) || name === DEFAULT_ACCOUNT) {
    logger.fatal({ name }, 'invalid account name in ACCOUNTS — refusing to start');
    process.exit(1);
  }
  createAccount({
    name,
    authDir: path.join(ACCOUNTS_DIR, name, 'auth-state'),
    dbPath: path.join(ACCOUNTS_DIR, name, 'wp.db'),
    prefix: `/a/${name}`,
  });
}

// Which numbers this server runs and whether each is linked. Admin-gated:
// it reveals the phone numbers.
app.get('/accounts', rateLimit({ windowMs: 60_000, max: 30 }), (c) => {
  if (!bearerMatches(c.req.header('Authorization'), ADMIN_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return c.json({ accounts: accounts.map((a) => a.status()) });
});

// Project apps own catch-all paths ('/', '/docs'), so they mount last, extra
// accounts before the root one.
for (const account of [...accounts].reverse()) {
  app.route(account.prefix || '/', account.projectApp);
}

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) =>
  logger.info({ port: info.port }, 'http listening')
);
