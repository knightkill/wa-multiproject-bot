import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { openDb } from './db.js';
import { bearerMatches } from './src/auth.js';
import { rateLimit } from './src/rate-limit.js';
import { createDmSender } from './src/dmQueue.js';
import { normalizeInbound } from './src/inbound.js';
import { createProjectApp } from './routes/project.js';
import { createAdminApp } from './routes/admin.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const AUTH_DIR = process.env.AUTH_DIR ?? '/data/auth-state';
const DB_PATH = process.env.DB_PATH ?? '/data/wp.db';
const PORT = Number(process.env.PORT ?? 8080);

if (!ADMIN_TOKEN) {
  logger.fatal('ADMIN_TOKEN env var required — refusing to start');
  process.exit(1);
}

const db = openDb(DB_PATH);
logger.info({ path: DB_PATH }, 'db ready');

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
  logger,
});
dmSender.start();

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      logger.info('QR refreshed — browse to GET /qr to scan');
    }

    if (connection === 'open') {
      paired = true;
      currentQR = null;
      logger.info('connected to WhatsApp');
    }

    if (connection === 'close') {
      paired = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn({ statusCode, loggedOut }, 'connection closed');
      if (!loggedOut) {
        setTimeout(() => start().catch((e) => logger.error(e, 'reconnect failed')), 2000);
      } else {
        logger.fatal('logged out — clear AUTH_DIR and re-pair via /qr');
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
        db.insertInboundMessage(row);
      } catch (err) {
        logger.warn({ err, id: message?.key?.id }, 'inbound capture failed');
      }
    }
  });
}

start().catch((e) => {
  logger.fatal(e, 'baileys start failed');
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

const app = new Hono();

// The pairing QR grants whoever scans it control of the bot's WhatsApp
// account, so it is gated by the admin token. Header-only on purpose: a token
// in the query string would land in browser history and proxy access logs.
app.get('/qr', rateLimit({ windowMs: 60_000, max: 30 }), async (c) => {
  if (!bearerMatches(c.req.header('Authorization'), ADMIN_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (paired) return c.json({ error: 'already paired' }, 404);
  if (!currentQR) return c.json({ error: 'no QR yet — try again in a few seconds' }, 503);
  const png = await QRCode.toBuffer(currentQR, { width: 512, margin: 2 });
  return new Response(png, { headers: { 'Content-Type': 'image/png' } });
});

// DM recipient allowlist (the WA-3 403 gate) is ON by default. Set
// DM_ALLOWLIST_ENABLED=false to bypass it so DMs can go to any recipient
// (caps + jitter + restriction auto-pause still apply). Operator opt-out.
const dmAllowlistEnabled = process.env.DM_ALLOWLIST_ENABLED !== 'false';
if (!dmAllowlistEnabled) {
  logger.warn('DM allowlist DISABLED (DM_ALLOWLIST_ENABLED=false) — DMs may target any recipient; caps/jitter/auto-pause still enforced');
}

const projectApp = createProjectApp({
  db,
  getSock: () => sock,
  isPaired: () => paired,
  groupsCache,
  dmSender,
  dmAllowlistEnabled,
  logger,
});
app.route('/', projectApp);

const adminApp = createAdminApp({
  db,
  getSock: () => sock,
  isPaired: () => paired,
  groupsCache,
  dmSender,
  adminToken: ADMIN_TOKEN,
  logger,
});
app.route('/admin', adminApp);

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) =>
  logger.info({ port: info.port }, 'http listening')
);
