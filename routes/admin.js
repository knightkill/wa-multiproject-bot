import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { bearerMatches } from '../src/auth.js';
import { rateLimit } from '../src/rate-limit.js';
import { ErrorEnvelope, OkResponse } from '../src/schemas/common.js';
import {
  IdParam,
  ProjectWithToken,
  ProjectListResponse,
  ProjectCreateBody,
  TokenResponse,
  ProjectGroupsBody,
  GroupsResponse,
  AllowlistResponse,
  AllowlistBody,
  AllowlistUpdateResponse,
  MessagesQuery,
  MessagesResponse,
  DmAllowlistResponse,
  DmAllowlistBody,
  DmAllowlistUpdateResponse,
  ReadableChatsResponse,
  ReadableChatsBody,
  InboundQuery,
  InboundResponse,
} from '../src/schemas/admin.js';
import { DmResumeResponse } from '../src/schemas/project.js';

const ADMIN_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'";

function zodErrorHook(result, c) {
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first.path.join('.') || '(root)';
    return c.json({ error: 'invalid request', detail: `${where}: ${first.message}` }, 400);
  }
}

export function createAdminApp({ db, getSock, isPaired, groupsCache, adminToken, logger, dmSender }) {
  const app = new OpenAPIHono({ defaultHook: zodErrorHook });

  const requireAdmin = async (c, next) => {
    if (!bearerMatches(c.req.header('Authorization'), adminToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };

  const adminHtmlPath = path.join(process.cwd(), 'public', 'admin.html');
  const serveAdminHtml = (c) => {
    const html = fs.readFileSync(adminHtmlPath, 'utf8');
    c.header('Content-Security-Policy', ADMIN_CSP);
    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.body(html);
  };
  app.get('/', serveAdminHtml);

  app.use(
    '/assets/*',
    serveStatic({
      root: './public',
      rewriteRequestPath: (p) => p.replace(/^\/admin\/assets/, '/assets'),
    })
  );

  const adminLimiter = rateLimit({ windowMs: 60_000, max: 120 });
  app.use('/api/*', adminLimiter, requireAdmin);
  app.use('/openapi.json', adminLimiter, requireAdmin);

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/projects',
      tags: ['projects'],
      summary: 'List all projects',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { content: { 'application/json': { schema: ProjectListResponse } }, description: 'OK' },
        401: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Unauthorized' },
      },
    }),
    (c) => c.json({ projects: db.listProjects() })
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/projects',
      tags: ['projects'],
      summary: 'Create a project (returns the token once)',
      security: [{ bearerAuth: [] }],
      request: { body: { content: { 'application/json': { schema: ProjectCreateBody } }, required: true } },
      responses: {
        201: { content: { 'application/json': { schema: ProjectWithToken } }, description: 'Created' },
        400: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Bad request' },
        409: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Name already in use' },
        500: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Create failed' },
      },
    }),
    (c) => {
      const { name, groupJids } = c.req.valid('json');
      const allowed = new Set(db.listAllowedGroups());
      for (const jid of groupJids) {
        if (!allowed.has(jid)) return c.json({ error: `group ${jid} not in allowlist` }, 400);
      }
      try {
        const project = db.createProject(name, groupJids);
        return c.json(project, 201);
      } catch (err) {
        if (String(err?.message ?? err).includes('UNIQUE')) {
          return c.json({ error: 'name already in use' }, 409);
        }
        logger.error(err, 'createProject failed');
        return c.json({ error: 'create failed' }, 500);
      }
    }
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/projects/{id}',
      tags: ['projects'],
      summary: 'Delete a project',
      security: [{ bearerAuth: [] }],
      request: { params: IdParam },
      responses: {
        200: { content: { 'application/json': { schema: OkResponse } }, description: 'Deleted' },
        404: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Not found' },
      },
    }),
    (c) => {
      const id = Number(c.req.valid('param').id);
      const ok = db.deleteProject(id);
      return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
    }
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/projects/{id}/rotate-token',
      tags: ['projects'],
      summary: 'Rotate the project token (returns the new one once)',
      security: [{ bearerAuth: [] }],
      request: { params: IdParam },
      responses: {
        200: { content: { 'application/json': { schema: TokenResponse } }, description: 'Rotated' },
        404: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Not found' },
      },
    }),
    (c) => {
      const id = Number(c.req.valid('param').id);
      const token = db.rotateProjectToken(id);
      return token ? c.json({ token }) : c.json({ error: 'not found' }, 404);
    }
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/projects/{id}/groups',
      tags: ['projects'],
      summary: 'Replace the per-project group access list',
      security: [{ bearerAuth: [] }],
      request: {
        params: IdParam,
        body: { content: { 'application/json': { schema: ProjectGroupsBody } }, required: true },
      },
      responses: {
        200: { content: { 'application/json': { schema: OkResponse } }, description: 'Updated' },
        400: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Group not in allowlist' },
        404: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Project not found' },
      },
    }),
    (c) => {
      const id = Number(c.req.valid('param').id);
      const { groupJids } = c.req.valid('json');
      const allowed = new Set(db.listAllowedGroups());
      for (const jid of groupJids) {
        if (!allowed.has(jid)) return c.json({ error: `group ${jid} not in allowlist` }, 400);
      }
      const ok = db.setProjectGroups(id, groupJids);
      return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
    }
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/groups',
      tags: ['groups'],
      summary: 'List live WhatsApp groups with allowlist flag',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { content: { 'application/json': { schema: GroupsResponse } }, description: 'OK' },
        503: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Not paired' },
      },
    }),
    async (c) => {
      if (!isPaired()) return c.json({ error: 'not paired' }, 503);
      const allowed = new Set(db.listAllowedGroups());
      const live = await groupsCache.get();
      return c.json({
        groups: live.map((g) => ({ jid: g.jid, subject: g.subject, allowed: allowed.has(g.jid) })),
      });
    }
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/allowlist',
      tags: ['allowlist'],
      summary: 'Get the global allowlist',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { content: { 'application/json': { schema: AllowlistResponse } }, description: 'OK' },
      },
    }),
    (c) => c.json({ jids: db.listAllowedGroups() })
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/allowlist',
      tags: ['allowlist'],
      summary: 'Replace the global allowlist',
      security: [{ bearerAuth: [] }],
      request: { body: { content: { 'application/json': { schema: AllowlistBody } }, required: true } },
      responses: {
        200: { content: { 'application/json': { schema: AllowlistUpdateResponse } }, description: 'Updated' },
      },
    }),
    (c) => {
      const { jids } = c.req.valid('json');
      db.setAllowedGroups(jids);
      return c.json({ ok: true, count: jids.length });
    }
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/dm-allowlist',
      tags: ['allowlist'],
      summary: 'Get the DM (1:1) recipient allowlist',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { content: { 'application/json': { schema: DmAllowlistResponse } }, description: 'OK' },
      },
    }),
    (c) => c.json({ jids: db.listDmAllowed() })
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/dm-allowlist',
      tags: ['allowlist'],
      summary: 'Replace the DM (1:1) recipient allowlist',
      security: [{ bearerAuth: [] }],
      request: { body: { content: { 'application/json': { schema: DmAllowlistBody } }, required: true } },
      responses: {
        200: { content: { 'application/json': { schema: DmAllowlistUpdateResponse } }, description: 'Updated' },
      },
    }),
    (c) => {
      const { jids } = c.req.valid('json');
      db.setDmAllowed(jids);
      return c.json({ ok: true, count: jids.length });
    }
  );

  // Deliberately admin-scoped: resuming after a WhatsApp restriction is a human
  // cool-off decision, not something a project token / automated loop may do.
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/dm/resume',
      tags: ['dm'],
      summary: 'Resume paused DM sending (operator/admin only)',
      description:
        'Clears the DM pause flag so the background queue resumes. Idempotency prevents any in-flight item from double-sending. Admin-scoped on purpose: the auto-pause exists to make the account cool off after a WhatsApp restriction, so coming back is a deliberate operator action.',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { content: { 'application/json': { schema: DmResumeResponse } }, description: 'Resumed' },
        401: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Unauthorized' },
      },
    }),
    (c) => {
      db.clearDmPause();
      logger.info('dm sending resumed (admin)');
      return c.json({ ok: true, resumed: true, status: dmSender.status() });
    }
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/messages',
      tags: ['messages'],
      summary: 'Recent send attempts (success and failure)',
      security: [{ bearerAuth: [] }],
      request: { query: MessagesQuery },
      responses: {
        200: { content: { 'application/json': { schema: MessagesResponse } }, description: 'OK' },
      },
    }),
    (c) => {
      const { project, group, limit } = c.req.valid('query');
      const rows = db.listMessages({
        project: project || null,
        group: group || null,
        limit: limit ? Number(limit) : 100,
      });
      return c.json({ messages: rows });
    }
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/readable-chats',
      tags: ['read'],
      summary: 'List chats the bot is capturing inbound messages from',
      security: [{ bearerAuth: [] }],
      responses: {
        200: { content: { 'application/json': { schema: ReadableChatsResponse } }, description: 'OK' },
      },
    }),
    async (c) => {
      const rows = db.listReadableChats();
      const subjects = new Map();
      if (isPaired()) {
        try {
          const live = await groupsCache.get();
          for (const g of live) subjects.set(g.jid, g.subject);
        } catch (err) {
          logger.warn({ err }, 'groupsCache lookup failed; subjects=null');
        }
      }
      return c.json({
        chats: rows.map((r) => ({
          ...r,
          subject: r.kind === 'group' ? subjects.get(r.jid) ?? null : null,
        })),
      });
    }
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/readable-chats',
      tags: ['read'],
      summary: 'Replace the set of chats the bot captures inbound messages from',
      security: [{ bearerAuth: [] }],
      request: { body: { content: { 'application/json': { schema: ReadableChatsBody } }, required: true } },
      responses: {
        200: { content: { 'application/json': { schema: OkResponse } }, description: 'Updated' },
        400: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Bad request' },
      },
    }),
    (c) => {
      const { chats } = c.req.valid('json');
      const seen = new Set();
      for (const ch of chats) {
        if (seen.has(ch.jid)) return c.json({ error: `duplicate jid: ${ch.jid}` }, 400);
        seen.add(ch.jid);
      }
      db.setReadableChats(chats);
      return c.json({ ok: true });
    }
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/inbound',
      tags: ['read'],
      summary: 'Recent inbound messages from readable chats',
      description:
        'Returns inbound messages captured from chats in /api/readable-chats. ' +
        'Order: newest first. For polling, pass ?since=<nextCursor> from the previous response to get only newer messages.',
      security: [{ bearerAuth: [] }],
      request: { query: InboundQuery },
      responses: {
        200: { content: { 'application/json': { schema: InboundResponse } }, description: 'OK' },
      },
    }),
    (c) => {
      const { jid, since, fromMe, limit } = c.req.valid('query');
      const rows = db.listInboundMessages({
        jid: jid || null,
        since: since != null ? Number(since) : null,
        fromMe: fromMe == null ? null : fromMe === 'true',
        limit: limit ? Number(limit) : 100,
      });
      const nextCursor = rows.length > 0 ? rows[0].id : null;
      return c.json({ messages: rows, nextCursor });
    }
  );

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'ADMIN_TOKEN.',
  });

  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'personal-whatsapp Admin API',
      version: '1.0.0',
      description: 'Internal admin/operator API. Not for public consumption.',
    },
  });

  return app;
}
