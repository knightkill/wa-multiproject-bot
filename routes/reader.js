import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { bearerMatches } from '../src/auth.js';
import { rateLimit } from '../src/rate-limit.js';
import { serveInboundMedia, parseMediaId } from '../src/media.js';
import { ReaderInboundQuery, InboundResponse } from '../src/schemas/admin.js';

const MIN_TOKEN_LENGTH = 32;

// Read-only, chat-scoped tier. READER_TOKEN unlocks GET /read/inbound and
// GET /read/inbound/:id/media only, and only for chats listed in READER_CHATS.
// It is deliberately a separate secret from ADMIN_TOKEN: the admin token is
// NOT accepted here, and the reader token is accepted nowhere else.
export function readerConfig({ readerToken, readerChats, adminToken, logger }) {
  const chats = new Set(
    (readerChats ?? '')
      .split(',')
      .map((j) => j.trim())
      .filter(Boolean)
  );
  const off = (why) => {
    if (why) logger?.warn(why);
    return { enabled: false, token: null, chats: new Set() };
  };
  if (!readerToken) return off(null);
  if (readerToken.length < MIN_TOKEN_LENGTH) {
    return off(`READER_TOKEN shorter than ${MIN_TOKEN_LENGTH} chars — reader routes disabled`);
  }
  if (readerToken === adminToken) {
    return off('READER_TOKEN equals ADMIN_TOKEN — reader routes disabled; use a separate secret');
  }
  if (chats.size === 0) logger?.warn('READER_TOKEN set but READER_CHATS empty — reader routes will return nothing');
  else logger?.info({ chats: chats.size }, 'reader routes enabled');
  return { enabled: true, token: readerToken, chats };
}

function zodErrorHook(result, c) {
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first.path.join('.') || '(root)';
    return c.json({ error: 'invalid request', detail: `${where}: ${first.message}` }, 400);
  }
}

export function createReaderApp({ db, reader, saveMedia, logger }) {
  const app = new OpenAPIHono({ defaultHook: zodErrorHook });
  const limiter = rateLimit({ windowMs: 60_000, max: 60 });

  if (!reader?.enabled) {
    // Feature off: answer like a wrong token, so the config is not revealed.
    app.use('*', limiter, (c) => c.json({ error: 'unauthorized' }, 401));
    return app;
  }

  const allowed = [...reader.chats];
  app.use('*', limiter, async (c, next) => {
    // Header-only: a token in the query string would end up in proxy logs.
    if (!bearerMatches(c.req.header('Authorization'), reader.token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  app.openapi(
    createRoute({
      method: 'get',
      path: '/inbound',
      request: { query: ReaderInboundQuery },
      responses: {
        200: { content: { 'application/json': { schema: InboundResponse } }, description: 'OK' },
      },
    }),
    (c) => {
      const { jid, since, sinceTs, fromMe, limit } = c.req.valid('query');
      // A jid outside the allowlist gets the same empty answer as a quiet
      // allowed chat, so the reader cannot probe which chats exist.
      if (jid && !reader.chats.has(jid)) return c.json({ messages: [], nextCursor: null });
      const rows = db.listInboundMessages({
        jid: jid || null,
        chats: allowed,
        since: since != null ? Number(since) : null,
        sinceTs: sinceTs != null ? Number(sinceTs) : null,
        fromMe: fromMe == null ? null : fromMe === 'true',
        limit: limit ? Number(limit) : 100,
      });
      const nextCursor = rows.length > 0 ? Math.max(...rows.map((r) => r.id)) : null;
      return c.json({ messages: rows, nextCursor });
    }
  );

  app.get('/inbound/:id/media', async (c) => {
    const id = parseMediaId(c.req.param('id'));
    if (id == null) return c.json({ error: 'bad id' }, 400);
    const media = db.getInboundMedia(id);
    // Same 404 for "no such message", "no media" and "not your chat".
    if (!media || !reader.chats.has(media.chatJid)) {
      return c.json({ error: 'no media on this message' }, 404);
    }
    return serveInboundMedia(c, { id, saveMedia, log: logger });
  });

  return app;
}
