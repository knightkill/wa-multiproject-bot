import QRCode from 'qrcode';
import { bearerMatches } from './auth.js';
import { rateLimit } from './rate-limit.js';
import { serveInboundMedia, parseMediaId } from './media.js';
import { createAdminApp } from '../routes/admin.js';
import { createReaderApp } from '../routes/reader.js';
import { createProjectApp } from '../routes/project.js';

// Every HTTP route for one account, under `prefix` ('' for the original).
// Returns the project app, which the caller mounts last because it owns
// catch-all paths. Kept free of Baileys so tests can drive it with stubs.
export function registerAccountRoutes(app, {
  prefix,
  db,
  adminToken,
  reader,
  getSock,
  isPaired,
  getCurrentQR,
  groupsCache,
  dmSender,
  dmAllowlistEnabled,
  saveMedia,
  log,
}) {
  // The pairing QR grants whoever scans it control of the bot's WhatsApp
  // account, so it is gated by the admin token. Header-only on purpose: a token
  // in the query string would land in browser history and proxy access logs.
  app.get(`${prefix}/qr`, rateLimit({ windowMs: 60_000, max: 30 }), async (c) => {
    if (!bearerMatches(c.req.header('Authorization'), adminToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (isPaired()) return c.json({ error: 'already paired' }, 404);
    const qr = getCurrentQR();
    if (!qr) return c.json({ error: 'no QR yet — try again in a few seconds' }, 503);
    const png = await QRCode.toBuffer(qr, { width: 512, margin: 2 });
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });

  // The file behind a captured image/document/voice note, downloading it from
  // WhatsApp first if it was not saved on arrival. Admin-gated like the rest
  // of the read API.
  app.get(`${prefix}/admin/api/inbound/:id/media`, rateLimit({ windowMs: 60_000, max: 60 }), async (c) => {
    if (!bearerMatches(c.req.header('Authorization'), adminToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const id = parseMediaId(c.req.param('id'));
    if (id == null) return c.json({ error: 'bad id' }, 400);
    if (!db.getInboundMedia(id)) return c.json({ error: 'no media on this message' }, 404);
    return serveInboundMedia(c, { id, saveMedia, log });
  });

  // Alternative to the QR: WhatsApp → Linked devices → Link a device → "Link
  // with phone number instead", then type this 8-character code. It outlives
  // a QR's ~20 s, which a QR relayed through chat often can't beat.
  app.post(`${prefix}/pairing-code`, rateLimit({ windowMs: 60_000, max: 5 }), async (c) => {
    if (!bearerMatches(c.req.header('Authorization'), adminToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (isPaired()) return c.json({ error: 'already paired' }, 404);
    const sock = getSock();
    if (!sock || !getCurrentQR()) return c.json({ error: 'not ready — try again in a few seconds' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const phone = String(body.phone ?? '').replace(/\D/g, '');
    if (!/^[1-9]\d{7,14}$/.test(phone)) {
      return c.json({ error: 'phone must be digits with country code, e.g. 919876543210' }, 400);
    }
    try {
      const code = await sock.requestPairingCode(phone);
      log.info({ phone }, 'pairing code issued');
      return c.json({ ok: true, code });
    } catch (err) {
      log.error({ err }, 'pairing code request failed');
      return c.json({ error: 'pairing code request failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const adminApp = createAdminApp({
    db,
    getSock,
    isPaired,
    groupsCache,
    dmSender,
    adminToken,
    logger: log,
  });
  app.route(`${prefix}/admin`, adminApp);

  // Read-only, chat-scoped tier (READER_TOKEN / READER_CHATS). Always mounted
  // so that, when disabled, /read/* answers 401 instead of falling through to
  // a project app's catch-all.
  app.route(`${prefix}/read`, createReaderApp({ db, reader, saveMedia, logger: log }));

  return createProjectApp({
    db,
    getSock,
    isPaired,
    groupsCache,
    dmSender,
    dmAllowlistEnabled,
    logger: log,
  });
}
