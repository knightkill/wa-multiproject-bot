import crypto from 'node:crypto';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { generateWAMessage, generateMessageIDV2 } from '@whiskeysockets/baileys';
import { ErrorEnvelope, OkResponse } from '../src/schemas/common.js';
import {
  PostBody,
  PostResponse,
  HealthResponse,
  PermittedGroupsResponse,
  GroupRef,
  GroupCreateBody,
  AddParticipantsBody,
  RemoveParticipantsBody,
  GroupSettingBody,
  GroupSubjectBody,
  GroupDescriptionBody,
  GroupCreateResponse,
  ParticipantsResponse,
  InviteResponse,
  SettingResponse,
  LeaveResponse,
  CommunityCreateBody,
  CommunityRef,
  CommunityCreateGroupBody,
  CommunityLinkBody,
  CommunityCreateResponse,
  CommunityCreateGroupResponse,
  CommunityLinkResponse,
  CommunityUnlinkResponse,
  CommunityListResponse,
  CommunitySubgroupsResponse,
  CommunityMetadataResponse,
  DmBody,
  DmBatchBody,
  DmResultResponse,
  DmBatchResponse,
  DmStatusResponse,
  DmStatusQuery,
  DmCancelBody,
  DmCancelResponse,
} from '../src/schemas/project.js';
import { transcodeVideo, TranscodeTimeout, TranscodeError } from '../src/transcode.js';
import { safeFetch, UnsafeUrlError } from '../src/safe-url.js';
import { rateLimit } from '../src/rate-limit.js';
import { toUserJid } from '../src/jid.js';

// WhatsApp silently drops inline video deliveries above ~16 MB for
// non-business accounts. We HEAD each video item; oversized ones go
// through ffmpeg before we touch sock.relayMessage.
const WHATSAPP_VIDEO_MAX_BYTES = 16 * 1024 * 1024;

// Wall budget for the whole Post (validation + fetch + transcode +
// upload + relay). Paired with fly.toml `idle_timeout = 300`.
const POST_DEADLINE_MS = 270_000;

// Bounded parallelism for the pre-upload phase. 2 keeps RAM peaks
// civil on the 256 MB box while halving wall time for image-heavy
// Posts.
const UPLOAD_CONCURRENCY = 2;

class InvalidItemError extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'InvalidItemError';
  }
}

function zodErrorHook(result, c) {
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first.path.join('.') || '(root)';
    return c.json({ error: 'invalid request', detail: `${where}: ${first.message}` }, 400);
  }
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function inviteLink(code) {
  return code ? 'https://chat.whatsapp.com/' + code : null;
}

// The raw `content` field is a binary node and is intentionally dropped.
function participantResult(el, mode) {
  const status = String(el.status);
  const out = { jid: el.jid, status, added: status === '200' };
  if (mode === 'add' && status !== '200') {
    if (status === '403') {
      out.note = 'cannot add (recipient privacy/blocked); share the invite link instead';
    } else if (status === '408') {
      out.note = 'recently left; cannot be re-added yet';
    } else if (status === '409') {
      out.note = 'already a participant';
    } else {
      out.note = 'add failed (status ' + status + ')';
    }
  }
  return out;
}

export function createProjectApp({ db, getSock, isPaired, groupsCache, logger, dmSender, dmAllowlistEnabled = true }) {
  const app = new OpenAPIHono({ defaultHook: zodErrorHook });

  app.use('*', rateLimit({ windowMs: 60_000, max: 240 }));

  const requireProject = async (c, next) => {
    const h = c.req.header('Authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    const project = token ? db.findProjectByToken(token) : null;
    if (!project) return c.json({ error: 'unauthorized' }, 401);
    c.set('project', project);
    await next();
  };

  // Unversioned by design.
  const healthRoute = createRoute({
    method: 'get',
    path: '/',
    tags: ['health'],
    summary: 'Liveness probe',
    description: 'Reports whether the bot is paired with WhatsApp and how many projects exist.',
    responses: {
      200: {
        content: { 'application/json': { schema: HealthResponse } },
        description: 'Server up',
      },
    },
  });

  app.openapi(healthRoute, (c) =>
    c.json({ ok: true, paired: isPaired(), projects: db.listProjects().length })
  );

  const postRoute = createRoute({
    method: 'post',
    path: '/v1/post',
    tags: ['messages'],
    summary: 'Post a message to a WhatsApp group',
    description:
      "Sends a Text card carrying title/caption/permalink, optionally followed by an Album of 1–10 ordered Media items (mixed image/* and video/*). Validates the target group is in this project's access × global allowlist. Videos over 16 MB are transcoded in-process before sending.",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: { 'application/json': { schema: PostBody } },
        required: true,
      },
    },
    responses: {
      200: { content: { 'application/json': { schema: PostResponse } }, description: 'Sent' },
      400: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Invalid request or media item' },
      401: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Missing or invalid project token' },
      403: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Target group not permitted for this project' },
      502: {
        content: { 'application/json': { schema: ErrorEnvelope } },
        description:
          'Upstream send failure: WhatsApp media fetch failure, ffmpeg transcode failure, or relay failure. Detail may indicate partial state when the Text card sent but the Album did not.',
      },
      503: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Bot is not paired with WhatsApp' },
      504: {
        content: { 'application/json': { schema: ErrorEnvelope } },
        description: 'Total Post deadline (270 s) or per-transcode deadline (120 s) exceeded.',
      },
    },
  });

  app.use(postRoute.getRoutingPath(), requireProject);

  app.openapi(postRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { groupJid, title, caption, permalink, media: mediaInput } = c.req.valid('json');
    const mediaItems = mediaInput ?? [];
    const mediaCount = mediaItems.length;

    const projectGroups = new Set(project.groupJids);
    const allowed = new Set(db.listAllowedGroups());
    if (!projectGroups.has(groupJid) || !allowed.has(groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }

    const lines = [`*${title}*`];
    if (caption && caption.trim()) lines.push('', caption.trim());
    if (permalink) lines.push('', permalink);
    const textCardBody = lines.join('\n');

    const userJid = sock.user?.id ?? sock.authState?.creds?.me?.id;
    const generateOpts = () => ({
      userJid,
      upload: sock.waUploadToServer,
      logger,
      messageId: generateMessageIDV2(userJid),
    });

    const logFailure = (detail) =>
      db.logMessage({
        projectName: project.name,
        groupJid,
        title,
        status: 'failed',
        error: detail,
        mediaCount,
      });

    const budget = new AbortController();
    const budgetTimer = setTimeout(
      () => budget.abort(new Error(`Post deadline (${POST_DEADLINE_MS}ms) exceeded`)),
      POST_DEADLINE_MS
    );

    try {
      let headResults;
      if (mediaCount > 0) {
        try {
          headResults = await Promise.all(
            mediaItems.map(async (item, idx) => {
              let head;
              try {
                head = await safeFetch(item.url, { method: 'HEAD', signal: budget.signal });
              } catch (err) {
                if (err instanceof UnsafeUrlError) {
                  throw new InvalidItemError(`item[${idx}] ${err.message}`);
                }
                throw err;
              }
              if (!head.ok) {
                throw new InvalidItemError(`item[${idx}] HEAD returned ${head.status}`);
              }
              const ct = (head.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
              const callerCat = item.type.split('/')[0];
              const serverCat = ct.split('/')[0];
              if (!serverCat || callerCat !== serverCat) {
                throw new InvalidItemError(
                  `item[${idx}] type category mismatch: caller=${item.type}, server=${ct || 'none'}`
                );
              }
              if (callerCat === 'video') {
                const lenStr = head.headers.get('content-length');
                if (!lenStr) {
                  throw new InvalidItemError(
                    `item[${idx}] video URL must return Content-Length on HEAD`
                  );
                }
                return { idx, kind: 'video', length: Number(lenStr), mimetype: ct };
              }
              return { idx, kind: 'image', mimetype: ct };
            })
          );
        } catch (err) {
          if (err instanceof InvalidItemError) {
            logFailure(err.message);
            return c.json({ error: 'invalid media item', detail: err.message }, 400);
          }
          throw err;
        }
      } else {
        headResults = [];
      }

      const buffers = [];
      for (const meta of headResults) {
        const item = mediaItems[meta.idx];
        if (meta.kind === 'video' && meta.length > WHATSAPP_VIDEO_MAX_BYTES) {
          const sourceSizeMb = (meta.length / 1024 / 1024).toFixed(1);
          logger.info(
            { project: project.name, jid: groupJid, idx: meta.idx, sourceSizeMb },
            'item video > 16 MB; transcoding'
          );
          try {
            const buf = await transcodeVideo(item.url, { logger, signal: budget.signal });
            buffers.push({ kind: 'video', buf, mimetype: 'video/mp4' });
          } catch (err) {
            if (err instanceof TranscodeTimeout) {
              const detail = `item[${meta.idx}] transcode timeout: ${err.message}`;
              logFailure(detail);
              return c.json({ error: 'transcode timed out', detail }, 504);
            }
            if (err instanceof TranscodeError) {
              const detail = `item[${meta.idx}] transcode failed: ${err.message}`;
              logFailure(detail);
              return c.json({ error: 'transcode failed', detail }, 502);
            }
            throw err;
          }
        } else {
          const res = await safeFetch(item.url, { signal: budget.signal });
          if (!res.ok) {
            const detail = `item[${meta.idx}] media fetch ${res.status}`;
            logFailure(detail);
            return c.json({ error: 'media fetch failed', detail }, 502);
          }
          const buf = Buffer.from(await res.arrayBuffer());
          buffers.push({ kind: meta.kind, buf, mimetype: meta.mimetype });
        }
      }

      const mediaProtos = await mapWithConcurrency(buffers, UPLOAD_CONCURRENCY, async (b) => {
        const content =
          b.kind === 'image' ? { image: b.buf } : { video: b.buf, mimetype: b.mimetype || 'video/mp4' };
        return generateWAMessage(groupJid, content, generateOpts());
      });

      const textCard = await generateWAMessage(groupJid, { text: textCardBody }, generateOpts());

      try {
        await sock.relayMessage(groupJid, textCard.message, { messageId: textCard.key.id });
      } catch (err) {
        const detail = `text card relay failed: ${err?.message ?? err}`;
        logFailure(detail);
        return c.json({ error: 'send failed', detail }, 502);
      }

      let relayedCount = 0;
      for (const proto of mediaProtos) {
        try {
          await sock.relayMessage(groupJid, proto.message, { messageId: proto.key.id });
          relayedCount++;
        } catch (err) {
          const detail = `partial send: text card delivered, ${relayedCount}/${mediaCount} media items relayed; failed at item[${relayedCount}]: ${err?.message ?? err}`;
          logFailure(detail);
          return c.json({ error: 'partial send', detail }, 502);
        }
      }

      db.logMessage({
        projectName: project.name,
        groupJid,
        title,
        status: 'sent',
        error: null,
        mediaCount,
      });
      logger.info({ project: project.name, jid: groupJid, mediaCount }, 'sent');
      return c.json({ ok: true, project: project.name, mediaCount });
    } catch (err) {
      if (budget.signal.aborted) {
        const detail = `Post deadline exceeded: ${budget.signal.reason?.message ?? 'unknown'}`;
        logFailure(detail);
        return c.json({ error: 'deadline exceeded', detail }, 504);
      }
      const detail = String(err?.message ?? err);
      logFailure(detail);
      logger.error({ err, project: project.name }, 'send failed');
      return c.json({ error: 'send failed', detail }, 502);
    } finally {
      clearTimeout(budgetTimer);
    }
  });

  const groupsRoute = createRoute({
    method: 'get',
    path: '/v1/groups',
    tags: ['messages'],
    summary: 'List groups this project can send to',
    description:
      "Returns the intersection of the project's configured group access and the global allowlist — i.e. the groups that POST /v1/post will accept right now. Each entry includes the WhatsApp subject when available (best-effort, null when the bot isn't paired or the group is not in the live cache).",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        content: { 'application/json': { schema: PermittedGroupsResponse } },
        description: 'OK',
      },
      401: {
        content: { 'application/json': { schema: ErrorEnvelope } },
        description: 'Missing or invalid project token',
      },
    },
  });

  app.use(groupsRoute.getRoutingPath(), requireProject);

  app.openapi(groupsRoute, async (c) => {
    const project = c.get('project');
    const allowed = new Set(db.listAllowedGroups());
    const permittedJids = project.groupJids.filter((j) => allowed.has(j));

    let subjects = new Map();
    if (isPaired() && permittedJids.length > 0) {
      try {
        const live = await groupsCache.get();
        for (const g of live) subjects.set(g.jid, g.subject);
      } catch (err) {
        logger.warn({ err }, 'groupsCache lookup failed; returning subject=null');
      }
    }

    const groups = permittedJids
      .map((jid) => ({ jid, subject: subjects.get(jid) ?? null }))
      .sort((a, b) => {
        if (a.subject === null && b.subject === null) return a.jid.localeCompare(b.jid);
        if (a.subject === null) return 1;
        if (b.subject === null) return -1;
        return a.subject.localeCompare(b.subject);
      });

    return c.json({ groups });
  });

  // Same scoping as POST /v1/post: a group op is permitted only when the
  // target JID is in (project access × global allowlist). create_group is
  // the documented exception — it self-grants after creating.
  const groupPermitted = (project, groupJid) => {
    const projectGroups = new Set(project.groupJids);
    const allowed = new Set(db.listAllowedGroups());
    return projectGroups.has(groupJid) && allowed.has(groupJid);
  };

  const groupErrorResponses = {
    400: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Invalid request or participant' },
    401: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Missing or invalid project token' },
    403: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Target group not permitted for this project' },
    502: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Upstream WhatsApp failure' },
    503: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Bot is not paired with WhatsApp' },
  };

  const createGroupRoute = createRoute({
    method: 'post',
    path: '/v1/groups/create',
    tags: ['groups'],
    summary: 'Create a WhatsApp group',
    description:
      'Creates an empty group, then appends the new JID to the global allowlist and this project\'s access so the project can immediately post to and manage it. Optional participants/announce/description steps run best-effort: their failures are collected into warnings[] rather than failing the call.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: GroupCreateBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: GroupCreateResponse } }, description: 'Created' },
      ...groupErrorResponses,
    },
  });

  app.use(createGroupRoute.getRoutingPath(), requireProject);

  app.openapi(createGroupRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { subject, participants, announce, description } = c.req.valid('json');

    // Normalize participants up front so a bad JID is a 400, not a partial create.
    let normalized;
    try {
      normalized = participants.map((p) => toUserJid(p));
    } catch (err) {
      return c.json({ error: 'invalid participant', detail: err.message }, 400);
    }

    let meta;
    try {
      meta = await sock.groupCreate(subject, []);
    } catch (err) {
      logger.error({ err, project: project.name }, 'groupCreate failed');
      return c.json({ error: 'group create failed', detail: String(err?.message ?? err) }, 502);
    }

    const newJid = meta.id;
    db.addAllowedGroup(newJid);
    db.addProjectGroup(project.id, newJid);

    const warnings = [];
    let participantResults = [];
    if (normalized.length) {
      try {
        const res = await sock.groupParticipantsUpdate(newJid, normalized, 'add');
        participantResults = res.map((el) => participantResult(el, 'add'));
      } catch (err) {
        warnings.push('add participants failed: ' + String(err?.message ?? err));
      }
    }

    if (announce) {
      try {
        await sock.groupSettingUpdate(newJid, 'announcement');
      } catch (err) {
        warnings.push('announce setting failed: ' + String(err?.message ?? err));
      }
    }

    if (description) {
      try {
        await sock.groupUpdateDescription(newJid, description);
      } catch (err) {
        warnings.push('description update failed: ' + String(err?.message ?? err));
      }
    }

    let code = null;
    try {
      code = await sock.groupInviteCode(newJid);
    } catch (err) {
      warnings.push('invite code fetch failed: ' + String(err?.message ?? err));
    }

    groupsCache.invalidate();
    logger.info({ project: project.name, jid: newJid, subject }, 'group created');

    return c.json({
      ok: true,
      groupJid: newJid,
      subject,
      inviteCode: code ?? null,
      inviteLink: inviteLink(code),
      participants: participantResults,
      settings: { announce },
      warnings,
    });
  });

  const addParticipantsRoute = createRoute({
    method: 'post',
    path: '/v1/groups/participants/add',
    tags: ['groups'],
    summary: 'Add participants to a group',
    description:
      'Adds up to 20 participants. Privacy-blocked recipients return a non-200 status with a note; share the invite link instead.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: AddParticipantsBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: ParticipantsResponse } }, description: 'Processed' },
      ...groupErrorResponses,
    },
  });

  app.use(addParticipantsRoute.getRoutingPath(), requireProject);

  app.openapi(addParticipantsRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { groupJid, participants } = c.req.valid('json');
    if (!groupPermitted(project, groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }
    let normalized;
    try {
      normalized = participants.map((p) => toUserJid(p));
    } catch (err) {
      return c.json({ error: 'invalid participant', detail: err.message }, 400);
    }
    try {
      const res = await sock.groupParticipantsUpdate(groupJid, normalized, 'add');
      logger.info({ project: project.name, jid: groupJid, count: normalized.length }, 'participants add');
      return c.json({ ok: true, results: res.map((el) => participantResult(el, 'add')) });
    } catch (err) {
      logger.error({ err, project: project.name, jid: groupJid }, 'participants add failed');
      return c.json({ error: 'participants add failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const removeParticipantsRoute = createRoute({
    method: 'post',
    path: '/v1/groups/participants/remove',
    tags: ['groups'],
    summary: 'Remove participants from a group',
    description: 'Removes up to 20 participants. Destructive: removed members lose access immediately.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: RemoveParticipantsBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: ParticipantsResponse } }, description: 'Processed' },
      ...groupErrorResponses,
    },
  });

  app.use(removeParticipantsRoute.getRoutingPath(), requireProject);

  app.openapi(removeParticipantsRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { groupJid, participants } = c.req.valid('json');
    if (!groupPermitted(project, groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }
    let normalized;
    try {
      normalized = participants.map((p) => toUserJid(p));
    } catch (err) {
      return c.json({ error: 'invalid participant', detail: err.message }, 400);
    }
    try {
      const res = await sock.groupParticipantsUpdate(groupJid, normalized, 'remove');
      logger.info({ project: project.name, jid: groupJid, count: normalized.length }, 'participants remove');
      return c.json({ ok: true, results: res.map((el) => participantResult(el, 'remove')) });
    } catch (err) {
      logger.error({ err, project: project.name, jid: groupJid }, 'participants remove failed');
      return c.json({ error: 'participants remove failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const inviteCodeRoute = createRoute({
    method: 'post',
    path: '/v1/groups/invite/code',
    tags: ['groups'],
    summary: 'Get a group invite code',
    description: 'Returns the current invite code and shareable link for a permitted group.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: GroupRef } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: InviteResponse } }, description: 'OK' },
      ...groupErrorResponses,
    },
  });

  app.use(inviteCodeRoute.getRoutingPath(), requireProject);

  app.openapi(inviteCodeRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { groupJid } = c.req.valid('json');
    if (!groupPermitted(project, groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }
    try {
      const code = await sock.groupInviteCode(groupJid);
      return c.json({ ok: true, code: code ?? null, link: inviteLink(code) });
    } catch (err) {
      logger.error({ err, project: project.name, jid: groupJid }, 'invite code failed');
      return c.json({ error: 'invite code failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const revokeInviteRoute = createRoute({
    method: 'post',
    path: '/v1/groups/invite/revoke',
    tags: ['groups'],
    summary: 'Revoke and rotate a group invite code',
    description: 'Invalidates the existing invite link and returns a fresh code/link.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: GroupRef } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: InviteResponse } }, description: 'OK' },
      ...groupErrorResponses,
    },
  });

  app.use(revokeInviteRoute.getRoutingPath(), requireProject);

  app.openapi(revokeInviteRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { groupJid } = c.req.valid('json');
    if (!groupPermitted(project, groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }
    try {
      const code = await sock.groupRevokeInvite(groupJid);
      logger.info({ project: project.name, jid: groupJid }, 'invite revoked');
      return c.json({ ok: true, code: code ?? null, link: inviteLink(code) });
    } catch (err) {
      logger.error({ err, project: project.name, jid: groupJid }, 'invite revoke failed');
      return c.json({ error: 'invite revoke failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const settingRoute = createRoute({
    method: 'post',
    path: '/v1/groups/setting',
    tags: ['groups'],
    summary: 'Change a group setting',
    description:
      'Sets announcement/not_announcement (who may post) or locked/unlocked (who may edit group info).',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: GroupSettingBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: SettingResponse } }, description: 'OK' },
      ...groupErrorResponses,
    },
  });

  app.use(settingRoute.getRoutingPath(), requireProject);

  app.openapi(settingRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { groupJid, setting } = c.req.valid('json');
    if (!groupPermitted(project, groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }
    try {
      await sock.groupSettingUpdate(groupJid, setting);
      logger.info({ project: project.name, jid: groupJid, setting }, 'group setting updated');
      return c.json({ ok: true, setting });
    } catch (err) {
      logger.error({ err, project: project.name, jid: groupJid }, 'group setting failed');
      return c.json({ error: 'group setting failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const subjectRoute = createRoute({
    method: 'post',
    path: '/v1/groups/subject',
    tags: ['groups'],
    summary: 'Rename a group',
    description: 'Updates the group subject (name).',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: GroupSubjectBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: OkResponse } }, description: 'OK' },
      ...groupErrorResponses,
    },
  });

  app.use(subjectRoute.getRoutingPath(), requireProject);

  app.openapi(subjectRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { groupJid, subject } = c.req.valid('json');
    if (!groupPermitted(project, groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }
    try {
      await sock.groupUpdateSubject(groupJid, subject);
      groupsCache.invalidate();
      logger.info({ project: project.name, jid: groupJid, subject }, 'group subject updated');
      return c.json({ ok: true });
    } catch (err) {
      logger.error({ err, project: project.name, jid: groupJid }, 'group subject failed');
      return c.json({ error: 'group subject failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const descriptionRoute = createRoute({
    method: 'post',
    path: '/v1/groups/description',
    tags: ['groups'],
    summary: 'Set a group description',
    description: 'Updates the group description. Pass "" to clear it.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: GroupDescriptionBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: OkResponse } }, description: 'OK' },
      ...groupErrorResponses,
    },
  });

  app.use(descriptionRoute.getRoutingPath(), requireProject);

  app.openapi(descriptionRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { groupJid, description } = c.req.valid('json');
    if (!groupPermitted(project, groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }
    try {
      await sock.groupUpdateDescription(groupJid, description);
      logger.info({ project: project.name, jid: groupJid }, 'group description updated');
      return c.json({ ok: true });
    } catch (err) {
      logger.error({ err, project: project.name, jid: groupJid }, 'group description failed');
      return c.json({ error: 'group description failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const leaveRoute = createRoute({
    method: 'post',
    path: '/v1/groups/leave',
    tags: ['groups'],
    summary: 'Leave a group',
    description:
      "Destructive: the bot leaves the group and the JID is removed from this project's access. The global allowlist is left unchanged (remove via admin UI if desired).",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: GroupRef } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: LeaveResponse } }, description: 'Left' },
      ...groupErrorResponses,
    },
  });

  app.use(leaveRoute.getRoutingPath(), requireProject);

  app.openapi(leaveRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { groupJid } = c.req.valid('json');
    if (!groupPermitted(project, groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }
    try {
      await sock.groupLeave(groupJid);
    } catch (err) {
      logger.error({ err, project: project.name, jid: groupJid }, 'group leave failed');
      return c.json({ error: 'group leave failed', detail: String(err?.message ?? err) }, 502);
    }
    const removed = db.removeProjectGroup(project.id, groupJid);
    groupsCache.invalidate();
    logger.info({ project: project.name, jid: groupJid, removed }, 'group left');
    return c.json({
      ok: true,
      leftGroup: groupJid,
      removedFromProject: removed,
      note: 'Global allowlist left unchanged; remove via admin UI if desired.',
    });
  });

  // Communities are @g.us JIDs, so they reuse groupPermitted() and the same
  // allowlist × project-access model. create endpoints self-grant the new JID.

  const communityCreateRoute = createRoute({
    method: 'post',
    path: '/v1/communities/create',
    tags: ['communities'],
    summary: 'Create a WhatsApp community',
    description:
      "Creates a community, then appends the new JID to the global allowlist and this project's access so the project can immediately manage it. The invite-code fetch runs best-effort: its failure is collected into warnings[] rather than failing the call.",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: CommunityCreateBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: CommunityCreateResponse } }, description: 'Created' },
      ...groupErrorResponses,
    },
  });

  app.use(communityCreateRoute.getRoutingPath(), requireProject);

  app.openapi(communityCreateRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { subject, description } = c.req.valid('json');

    let meta;
    try {
      meta = await sock.communityCreate(subject, description || '');
    } catch (err) {
      logger.error({ err, project: project.name }, 'communityCreate failed');
      return c.json({ error: 'community create failed', detail: String(err?.message ?? err) }, 502);
    }

    // Baileys 7.0 communityCreate resolves via groupMetadata of the new
    // group node, which can race and return null right after creation —
    // the Community exists but its JID came back unresolved. Recover by
    // matching the freshly-created Community by subject rather than
    // dereferencing null (which would surface as an opaque 500).
    let newJid = meta?.id;
    if (!newJid) {
      try {
        const all = await sock.communityFetchAllParticipating();
        const matches = Object.values(all)
          .filter((cm) => cm.isCommunity && cm.subject === subject)
          .sort((a, b) => (b.creation ?? 0) - (a.creation ?? 0));
        newJid = matches[0]?.id;
      } catch (err) {
        logger.warn({ err, project: project.name }, 'community jid recovery failed');
      }
    }
    if (!newJid) {
      return c.json(
        { error: 'community create unconfirmed', detail: 'community was created but its JID could not be resolved; check GET /v1/communities' },
        502
      );
    }
    db.addAllowedGroup(newJid);
    db.addProjectGroup(project.id, newJid);

    const warnings = [];
    let code = null;
    try {
      code = await sock.communityInviteCode(newJid);
    } catch (err) {
      warnings.push('invite code fetch failed: ' + String(err?.message ?? err));
    }

    groupsCache.invalidate();
    logger.info({ project: project.name, jid: newJid, subject }, 'community created');

    return c.json({
      ok: true,
      communityJid: newJid,
      subject,
      inviteCode: code ?? null,
      inviteLink: inviteLink(code),
      warnings,
    });
  });

  const communityCreateGroupRoute = createRoute({
    method: 'post',
    path: '/v1/communities/create-group',
    tags: ['communities'],
    summary: 'Create a subgroup under a community',
    description:
      "Creates a subgroup under a permitted parent community, then appends the new JID to the global allowlist and this project's access. Optional participants/announce/description steps run best-effort: their failures are collected into warnings[] rather than failing the call.",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: CommunityCreateGroupBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: CommunityCreateGroupResponse } }, description: 'Created' },
      ...groupErrorResponses,
    },
  });

  app.use(communityCreateGroupRoute.getRoutingPath(), requireProject);

  app.openapi(communityCreateGroupRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { parentJid, subject, participants, announce, description } = c.req.valid('json');
    if (!groupPermitted(project, parentJid)) {
      return c.json({ error: 'parentJid not permitted for this project' }, 403);
    }

    // Normalize participants up front so a bad JID is a 400, not a partial create.
    let normalized;
    try {
      normalized = participants.map((p) => toUserJid(p));
    } catch (err) {
      return c.json({ error: 'invalid participant', detail: err.message }, 400);
    }

    let meta;
    try {
      meta = await sock.communityCreateGroup(subject, [], parentJid);
    } catch (err) {
      logger.error({ err, project: project.name, parentJid }, 'communityCreateGroup failed');
      return c.json({ error: 'community group create failed', detail: String(err?.message ?? err) }, 502);
    }

    // Same null-race as communityCreate: recover the new sub-group JID by
    // matching its subject among the parent Community's linked groups.
    let newJid = meta?.id;
    if (!newJid) {
      try {
        const res = await sock.communityFetchLinkedGroups(parentJid);
        const matches = (res?.linkedGroups ?? [])
          .filter((g) => g.subject === subject)
          .sort((a, b) => (b.creation ?? 0) - (a.creation ?? 0));
        newJid = matches[0]?.id;
      } catch (err) {
        logger.warn({ err, project: project.name, parentJid }, 'sub-group jid recovery failed');
      }
    }
    if (!newJid) {
      return c.json(
        { error: 'community group create unconfirmed', detail: 'sub-group was created but its JID could not be resolved; check POST /v1/communities/subgroups' },
        502
      );
    }
    db.addAllowedGroup(newJid);
    db.addProjectGroup(project.id, newJid);

    const warnings = [];
    let participantResults = [];
    if (normalized.length) {
      try {
        const res = await sock.groupParticipantsUpdate(newJid, normalized, 'add');
        participantResults = res.map((el) => participantResult(el, 'add'));
      } catch (err) {
        warnings.push('add participants failed: ' + String(err?.message ?? err));
      }
    }

    if (announce) {
      try {
        await sock.groupSettingUpdate(newJid, 'announcement');
      } catch (err) {
        warnings.push('announce setting failed: ' + String(err?.message ?? err));
      }
    }

    if (description) {
      try {
        await sock.groupUpdateDescription(newJid, description);
      } catch (err) {
        warnings.push('description update failed: ' + String(err?.message ?? err));
      }
    }

    let code = null;
    try {
      code = await sock.groupInviteCode(newJid);
    } catch (err) {
      warnings.push('invite code fetch failed: ' + String(err?.message ?? err));
    }

    groupsCache.invalidate();
    logger.info({ project: project.name, jid: newJid, parentJid, subject }, 'community subgroup created');

    return c.json({
      ok: true,
      groupJid: newJid,
      parentJid,
      subject,
      inviteCode: code ?? null,
      inviteLink: inviteLink(code),
      participants: participantResults,
      settings: { announce },
      warnings,
    });
  });

  const communityLinkRoute = createRoute({
    method: 'post',
    path: '/v1/communities/link',
    tags: ['communities'],
    summary: 'Link a group into a community',
    description: 'Links a permitted group into a permitted parent community.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: CommunityLinkBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: CommunityLinkResponse } }, description: 'Linked' },
      ...groupErrorResponses,
    },
  });

  app.use(communityLinkRoute.getRoutingPath(), requireProject);

  app.openapi(communityLinkRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { parentJid, groupJid } = c.req.valid('json');
    if (!groupPermitted(project, parentJid)) {
      return c.json({ error: 'parentJid not permitted for this project' }, 403);
    }
    if (!groupPermitted(project, groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }
    try {
      await sock.communityLinkGroup(groupJid, parentJid);
      groupsCache.invalidate();
      logger.info({ project: project.name, jid: groupJid, parentJid }, 'community group linked');
      return c.json({ ok: true, linked: true, groupJid, parentJid });
    } catch (err) {
      logger.error({ err, project: project.name, jid: groupJid, parentJid }, 'community link failed');
      return c.json({ error: 'community link failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const communityUnlinkRoute = createRoute({
    method: 'post',
    path: '/v1/communities/unlink',
    tags: ['communities'],
    summary: 'Unlink a group from a community',
    description: 'Unlinks a permitted group from a permitted parent community.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: CommunityLinkBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: CommunityUnlinkResponse } }, description: 'Unlinked' },
      ...groupErrorResponses,
    },
  });

  app.use(communityUnlinkRoute.getRoutingPath(), requireProject);

  app.openapi(communityUnlinkRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { parentJid, groupJid } = c.req.valid('json');
    if (!groupPermitted(project, parentJid)) {
      return c.json({ error: 'parentJid not permitted for this project' }, 403);
    }
    if (!groupPermitted(project, groupJid)) {
      return c.json({ error: 'groupJid not permitted for this project' }, 403);
    }
    try {
      await sock.communityUnlinkGroup(groupJid, parentJid);
      groupsCache.invalidate();
      logger.info({ project: project.name, jid: groupJid, parentJid }, 'community group unlinked');
      return c.json({ ok: true, unlinked: true, groupJid, parentJid });
    } catch (err) {
      logger.error({ err, project: project.name, jid: groupJid, parentJid }, 'community unlink failed');
      return c.json({ error: 'community unlink failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const communityListRoute = createRoute({
    method: 'get',
    path: '/v1/communities',
    tags: ['communities'],
    summary: 'List communities the bot participates in',
    description:
      "Read-only discovery: lists every community the bot belongs to, annotating each with whether it is permitted for this project (in project access × global allowlist). No 403 — non-permitted communities are returned with permitted:false.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: { content: { 'application/json': { schema: CommunityListResponse } }, description: 'OK' },
      401: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Missing or invalid project token' },
      502: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Upstream WhatsApp failure' },
      503: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Bot is not paired with WhatsApp' },
    },
  });

  app.use(communityListRoute.getRoutingPath(), requireProject);

  app.openapi(communityListRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    try {
      const raw = await sock.communityFetchAllParticipating();
      const communities = Object.values(raw)
        .filter((cm) => cm.isCommunity)
        .map((cm) => ({
          jid: cm.id,
          subject: cm.subject ?? null,
          size: cm.size ?? null,
          permitted: groupPermitted(project, cm.id),
        }));
      return c.json({ ok: true, communities });
    } catch (err) {
      logger.error({ err, project: project.name }, 'community list failed');
      return c.json({ error: 'community list failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const communitySubgroupsRoute = createRoute({
    method: 'post',
    path: '/v1/communities/subgroups',
    tags: ['communities'],
    summary: 'List subgroups linked under a community',
    description: 'Returns the groups linked under a permitted community.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: CommunityRef } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: CommunitySubgroupsResponse } }, description: 'OK' },
      ...groupErrorResponses,
    },
  });

  app.use(communitySubgroupsRoute.getRoutingPath(), requireProject);

  app.openapi(communitySubgroupsRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { communityJid } = c.req.valid('json');
    if (!groupPermitted(project, communityJid)) {
      return c.json({ error: 'communityJid not permitted for this project' }, 403);
    }
    try {
      const res = await sock.communityFetchLinkedGroups(communityJid);
      return c.json({
        ok: true,
        communityJid: res.communityJid,
        isCommunity: res.isCommunity,
        subgroups: res.linkedGroups,
      });
    } catch (err) {
      logger.error({ err, project: project.name, jid: communityJid }, 'community subgroups failed');
      return c.json({ error: 'community subgroups failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  const communityMetadataRoute = createRoute({
    method: 'post',
    path: '/v1/communities/metadata',
    tags: ['communities'],
    summary: 'Fetch community metadata',
    description: 'Returns subject/description/settings for a permitted community.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: CommunityRef } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: CommunityMetadataResponse } }, description: 'OK' },
      ...groupErrorResponses,
    },
  });

  app.use(communityMetadataRoute.getRoutingPath(), requireProject);

  app.openapi(communityMetadataRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const sock = getSock();
    const project = c.get('project');
    const { communityJid } = c.req.valid('json');
    if (!groupPermitted(project, communityJid)) {
      return c.json({ error: 'communityJid not permitted for this project' }, 403);
    }
    try {
      // A Community's parent is a Group, so groupMetadata returns the
      // community fields (isCommunity/linkedParent/announce) reliably;
      // sock.communityMetadata expects a <community> node that the
      // interactive query does not return for a parent group (it returns
      // <group>), so it throws in 7.0.0-rc13.
      const m = await sock.groupMetadata(communityJid);
      return c.json({
        ok: true,
        jid: m.id,
        subject: m.subject ?? null,
        desc: m.desc ?? null,
        isCommunity: !!m.isCommunity,
        linkedParent: m.linkedParent ?? null,
        announce: !!m.announce,
        size: m.size ?? null,
      });
    } catch (err) {
      logger.error({ err, project: project.name, jid: communityJid }, 'community metadata failed');
      return c.json({ error: 'community metadata failed', detail: String(err?.message ?? err) }, 502);
    }
  });

  // DM is opt-in / low-volume only — the recommended distribution path
  // remains an invite-link group Post (POST /v1/post). Every safeguard
  // (jitter + per-minute/per-day caps) lives server-side in dmSender and
  // cannot be set or raised from the request; no jitter/cap fields are
  // accepted in any schema here. Recipients must be on the DM allowlist
  // (managed via the admin UI) or the send is refused with a 403.
  const dmErrorResponses = {
    400: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Invalid recipient' },
    401: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Missing or invalid project token' },
    403: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Recipient not on the DM allowlist' },
    423: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'DM sending is paused (operator or auto-pause)' },
    429: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'DM cap reached, or WhatsApp restricted the account (auto-paused)' },
    502: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Upstream WhatsApp send failure' },
    503: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Bot is not paired with WhatsApp' },
  };

  const batchCounts = (batchId) => {
    const rows = db.listDmQueue({ batchId, limit: 500 });
    const counts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of rows) {
      if (counts[r.status] !== undefined) counts[r.status]++;
    }
    return { batchId, ...counts };
  };

  const dmRoute = createRoute({
    method: 'post',
    path: '/v1/dm',
    tags: ['dm'],
    summary: 'Send a 1:1 direct message (high ban-risk)',
    description:
      'Sends a single text DM to one recipient. HIGH BAN-RISK: direct messaging is throttled server-side (per-minute + per-day caps and randomized jitter) and the rate cannot be raised by the caller. The recipient must be on the DM allowlist. Prefer an invite-link group Post (POST /v1/post) for distribution.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: DmBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: DmResultResponse } }, description: 'Sent' },
      ...dmErrorResponses,
    },
  });

  app.use(dmRoute.getRoutingPath(), requireProject);

  app.openapi(dmRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const project = c.get('project');
    const { toJid, text } = c.req.valid('json');

    let jid;
    try {
      jid = toUserJid(toJid);
    } catch (err) {
      return c.json({ error: 'invalid recipient', detail: err.message }, 400);
    }

    if (dmAllowlistEnabled && !db.isDmAllowed(jid)) {
      return c.json({ error: 'recipient not permitted (not in DM allowlist)' }, 403);
    }

    try {
      const res = await dmSender.sendNow(jid, text);
      logger.info({ project: project.name, jid }, 'dm sent');
      return c.json({ ok: true, toJid: jid, status: res.status });
    } catch (err) {
      switch (err?.code) {
        case 'cap':
          return c.json({ error: 'dm cap reached', detail: err.detail ?? err.message }, 429);
        case 'paused':
          return c.json({ error: 'dm sending paused', detail: err.detail ?? err.message }, 423);
        case 'restricted':
          return c.json(
            { error: 'whatsapp restricted; dm sending auto-paused', detail: err.detail ?? err.message },
            429
          );
        case 'send_failed':
          return c.json({ error: 'dm send failed', detail: err.detail ?? err.message }, 502);
        default:
          logger.error({ err, project: project.name, jid }, 'dm send unexpected failure');
          return c.json({ error: 'dm send failed', detail: String(err?.message ?? err) }, 502);
      }
    }
  });

  const dmBatchRoute = createRoute({
    method: 'post',
    path: '/v1/dm/batch',
    tags: ['dm'],
    summary: 'Enqueue a batch of 1:1 DMs (background, throttled)',
    description:
      'Enqueues up to 50 text DMs. HIGH BAN-RISK: nothing is sent synchronously — the queue drains in the background with server-side caps and randomized jitter that the caller cannot raise. Recipients not on the DM allowlist are returned in skipped[] and never sent. Duplicate (batch, recipient) pairs are de-duplicated via an idempotency key. Prefer an invite-link group Post for distribution.',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: DmBatchBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: DmBatchResponse } }, description: 'Enqueued' },
      400: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Invalid recipient' },
      401: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Missing or invalid project token' },
      503: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Bot is not paired with WhatsApp' },
    },
  });

  app.use(dmBatchRoute.getRoutingPath(), requireProject);

  app.openapi(dmBatchRoute, async (c) => {
    if (!isPaired()) return c.json({ error: 'not paired' }, 503);
    const project = c.get('project');
    const { recipients, text } = c.req.valid('json');

    let normalized;
    try {
      normalized = recipients.map((r) => toUserJid(r));
    } catch (err) {
      return c.json({ error: 'invalid recipient', detail: err.message }, 400);
    }

    const allowed = [];
    const skipped = [];
    for (const jid of normalized) {
      if (!dmAllowlistEnabled || db.isDmAllowed(jid)) allowed.push(jid);
      else skipped.push({ jid, reason: 'not in DM allowlist' });
    }

    const batchId = crypto.randomBytes(32).toString('base64url');
    const { enqueued, duplicates } = dmSender.enqueueBatch(
      allowed.map((jid) => ({ toJid: jid, body: text })),
      batchId
    );

    logger.info(
      { project: project.name, batchId, enqueued, duplicates, skipped: skipped.length },
      'dm batch enqueued'
    );
    return c.json({ ok: true, batchId, enqueued, duplicates, skipped });
  });

  const dmStatusRoute = createRoute({
    method: 'get',
    path: '/v1/dm/status',
    tags: ['dm'],
    summary: 'DM sender status and caps',
    description:
      'Reports pause state, pending count, recent send volume, and the server-side caps (read-only — caps cannot be changed via the API). Pass batchId to also get that batch\'s pending/sent/failed/skipped counts.',
    security: [{ bearerAuth: [] }],
    request: { query: DmStatusQuery },
    responses: {
      200: { content: { 'application/json': { schema: DmStatusResponse } }, description: 'OK' },
      401: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Missing or invalid project token' },
    },
  });

  app.use(dmStatusRoute.getRoutingPath(), requireProject);

  app.openapi(dmStatusRoute, (c) => {
    const { batchId } = c.req.valid('query');
    const status = dmSender.status();
    if (batchId) status.batch = batchCounts(batchId);
    return c.json(status);
  });

  // NOTE: resuming after an auto-pause is an ADMIN/operator action, not a
  // project one — see POST /admin/api/dm/resume in routes/admin.js. Project
  // scope is deliberately withheld so an automated project loop cannot clear
  // the cooldown and re-hammer an already-restricted account.

  const dmCancelRoute = createRoute({
    method: 'post',
    path: '/v1/dm/cancel',
    tags: ['dm'],
    summary: 'Cancel pending DMs in a batch',
    description: 'Marks every still-pending row in the batch as skipped (already-sent rows are untouched).',
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: DmCancelBody } }, required: true } },
    responses: {
      200: { content: { 'application/json': { schema: DmCancelResponse } }, description: 'Cancelled' },
      401: { content: { 'application/json': { schema: ErrorEnvelope } }, description: 'Missing or invalid project token' },
    },
  });

  app.use(dmCancelRoute.getRoutingPath(), requireProject);

  app.openapi(dmCancelRoute, (c) => {
    const project = c.get('project');
    const { batchId } = c.req.valid('json');
    const cancelled = db.cancelDmBatch(batchId, 'cancelled');
    logger.info({ project: project.name, batchId, cancelled }, 'dm batch cancelled');
    return c.json({ ok: true, cancelled });
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Per-project bearer token issued via the admin UI.',
  });

  app.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'personal-whatsapp Project API',
      version: '1.0.0',
      description:
        "HTTP API used by your projects to forward messages to their WhatsApp groups.",
    },
  });

  app.get('/docs', (c) =>
    c.html(`<!doctype html>
<html>
<head>
  <title>personal-whatsapp Project API</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
  <redoc spec-url="/openapi.json"></redoc>
  <script src="https://cdn.redocly.com/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>`)
  );

  return app;
}
