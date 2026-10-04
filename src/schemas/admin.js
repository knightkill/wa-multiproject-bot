import { z, GroupJid, ChatJid } from './common.js';

export const IdParam = z
  .object({
    id: z
      .string()
      .regex(/^\d+$/, 'numeric id required')
      .openapi({ param: { name: 'id', in: 'path' }, example: '1' }),
  });

export const Project = z
  .object({
    id: z.number().int(),
    name: z.string(),
    createdAt: z.number().int(),
    groupJids: z.array(GroupJid),
  })
  .openapi('Project');

export const ProjectWithToken = Project.extend({
  token: z.string(),
}).openapi('ProjectWithToken');

export const ProjectListResponse = z
  .object({ projects: z.array(Project) })
  .openapi('ProjectList');

export const ProjectCreateBody = z
  .object({
    name: z.string().trim().min(1),
    groupJids: z.array(GroupJid).default([]),
  })
  .openapi('ProjectCreateBody');

export const TokenResponse = z
  .object({ token: z.string() })
  .openapi('Token');

export const ProjectGroupsBody = z
  .object({ groupJids: z.array(GroupJid) })
  .openapi('ProjectGroupsBody');

export const LiveGroup = z.object({
  jid: GroupJid,
  subject: z.string(),
  allowed: z.boolean(),
});

export const GroupsResponse = z
  .object({ groups: z.array(LiveGroup) })
  .openapi('GroupList');

export const AllowlistResponse = z
  .object({ jids: z.array(GroupJid) })
  .openapi('Allowlist');

export const AllowlistBody = z
  .object({ jids: z.array(GroupJid) })
  .openapi('AllowlistBody');

export const AllowlistUpdateResponse = z
  .object({ ok: z.literal(true), count: z.number().int().nonnegative() })
  .openapi('AllowlistUpdated');

export const MessagesQuery = z.object({
  project: z.string().optional().openapi({ param: { name: 'project', in: 'query' } }),
  group: z.string().optional().openapi({ param: { name: 'group', in: 'query' } }),
  limit: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .openapi({ param: { name: 'limit', in: 'query' }, example: '100' }),
});

export const MessageRow = z
  .object({
    id: z.number().int(),
    project_name: z.string(),
    group_jid: GroupJid,
    title: z.string(),
    status: z.enum(['sent', 'failed']),
    error: z.string().nullable(),
    created_at: z.number().int(),
    media_count: z.number().int().nonnegative(),
  })
  .openapi('MessageRow');

export const MessagesResponse = z
  .object({ messages: z.array(MessageRow) })
  .openapi('MessageList');

// Items are user JIDs (@s.whatsapp.net or @lid). Operators set this
// so the project DM endpoints can only target opted-in recipients.
export const UserJid = z
  .string()
  .regex(
    /^\d+@(s\.whatsapp\.net|lid)$/,
    'must be a WhatsApp user JID, e.g. 6191234567@s.whatsapp.net'
  )
  .openapi({ example: '6191234567@s.whatsapp.net' });

export const DmAllowlistResponse = z
  .object({ jids: z.array(UserJid) })
  .openapi('DmAllowlist');

export const DmAllowlistBody = z
  .object({ jids: z.array(UserJid) })
  .openapi('DmAllowlistBody');

export const DmAllowlistUpdateResponse = z
  .object({ ok: z.literal(true), count: z.number().int().nonnegative() })
  .openapi('DmAllowlistUpdated');

export const ReadableChatInput = z
  .object({
    jid: ChatJid,
    kind: z.enum(['group', 'person']),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .refine((c) => (c.kind === 'group') === c.jid.endsWith('@g.us'), {
    message: 'kind must match the JID suffix (group ↔ @g.us, person ↔ @s.whatsapp.net or @lid)',
  })
  .openapi('ReadableChatInput');

export const ReadableChat = z
  .object({
    jid: ChatJid,
    kind: z.enum(['group', 'person']),
    label: z.string().nullable(),
    addedAt: z.number().int(),
    subject: z.string().nullable().openapi({
      description: 'Live WhatsApp group subject when available (groups only); null otherwise.',
    }),
  })
  .openapi('ReadableChat');

export const ReadableChatsResponse = z
  .object({ chats: z.array(ReadableChat) })
  .openapi('ReadableChats');

export const ReadableChatsBody = z
  .object({ chats: z.array(ReadableChatInput) })
  .openapi('ReadableChatsBody');

export const InboundQuery = z.object({
  jid: z.string().optional().openapi({ param: { name: 'jid', in: 'query' } }),
  since: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .openapi({ param: { name: 'since', in: 'query' }, example: '0' }),
  fromMe: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ param: { name: 'fromMe', in: 'query' } }),
  limit: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .openapi({ param: { name: 'limit', in: 'query' }, example: '100' }),
});

export const InboundMessage = z
  .object({
    id: z.number().int(),
    wa_id: z.string(),
    chat_jid: ChatJid,
    sender_jid: z.string().nullable(),
    from_me: z.number().int(),
    timestamp: z.number().int(),
    text: z.string().nullable(),
    media_type: z.string().nullable(),
    quoted_wa_id: z.string().nullable(),
    media_mime: z.string().nullable(),
    media_saved: z.number().int(),
  })
  .openapi('InboundMessage');

export const InboundResponse = z
  .object({
    messages: z.array(InboundMessage),
    nextCursor: z.number().int().nullable().openapi({
      description:
        'Highest id in the returned batch. Pass as ?since= on the next poll to get only newer messages.',
    }),
  })
  .openapi('InboundList');
