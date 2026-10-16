import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { bearerMatches } from '../src/auth.js';
import { rateLimit } from '../src/rate-limit.js';
import { collapseGoogle } from '../src/contacts.js';
import { ErrorEnvelope } from '../src/schemas/common.js';
import { GoogleContactsBody, GoogleContactsResponse } from '../src/schemas/admin.js';

const MIN_TOKEN_LENGTH = 32;

// CONTACTS_PUSH_TOKEN is the only credential the Google Apps Script holds, so
// it unlocks this one write and nothing else; the admin token is not
// accepted here. Mirrors the reader-token checks.
export function contactsPushToken({ token, adminToken, readerToken, logger }) {
  if (!token) return null;
  if (token.length < MIN_TOKEN_LENGTH) {
    logger?.warn(`CONTACTS_PUSH_TOKEN shorter than ${MIN_TOKEN_LENGTH} chars — Google contacts push disabled`);
    return null;
  }
  if (token === adminToken || token === readerToken) {
    logger?.warn('CONTACTS_PUSH_TOKEN reuses another token — Google contacts push disabled; use a separate secret');
    return null;
  }
  return token;
}

function zodErrorHook(result, c) {
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first.path.join('.') || '(root)';
    return c.json({ error: 'invalid request', detail: `${where}: ${first.message}` }, 400);
  }
}

export function createContactsPushApp({ db, pushToken, logger }) {
  const app = new OpenAPIHono({ defaultHook: zodErrorHook });
  const limiter = rateLimit({ windowMs: 60_000, max: 10 });

  app.use('*', limiter, async (c, next) => {
    // Unset token: answer like a wrong one, so the config is not revealed.
    if (!pushToken || !bearerMatches(c.req.header('Authorization'), pushToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  app.openapi(
    createRoute({
      method: 'put',
      path: '/google',
      tags: ['contacts'],
      summary: 'Replace the Google Contacts snapshot',
      description:
        'Full snapshot: every Google name not in this body is cleared. Phones are normalised to WhatsApp JIDs (India by default); duplicates sharing a number collapse to the most recently updated name, with the other spellings kept as aliases.',
      security: [{ bearerAuth: [] }],
      request: { body: { content: { 'application/json': { schema: GoogleContactsBody } }, required: true } },
      responses: {
        200: { content: { 'application/json': { schema: GoogleContactsResponse } }, description: 'Stored' },
        401: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Unauthorized' },
      },
    }),
    (c) => {
      const { contacts } = c.req.valid('json');
      const { contacts: byJid, skipped } = collapseGoogle(contacts);
      db.replaceGoogleContacts(byJid);
      logger.info({ received: contacts.length, numbers: byJid.size, skipped }, 'google contacts snapshot stored');
      return c.json({
        ok: true,
        received: contacts.length,
        numbers: byJid.size,
        skippedPhones: skipped,
        counts: db.contactCounts(),
      });
    }
  );

  return app;
}
