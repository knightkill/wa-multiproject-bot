import { z, GroupJid, MediaType } from './common.js';

const ParticipantId = z
  .string()
  .min(1)
  .openapi({
    example: '6191234567',
    description:
      'Phone number (digits, any formatting) or an explicit user JID (@s.whatsapp.net or @lid).',
  });

const ParticipantResult = z
  .object({
    jid: z.string(),
    status: z.string().openapi({ example: '200' }),
    added: z.boolean(),
    note: z.string().optional().openapi({
      description: 'Human-readable hint when an add did not succeed (non-200 status).',
    }),
  })
  .openapi('ParticipantResult');

export const MediaItem = z
  .object({
    url: z.string().url().openapi({ example: 'https://example.com/cover.jpg' }),
    type: MediaType,
  })
  .openapi('MediaItem');

export const PostBody = z
  .object({
    groupJid: GroupJid,
    title: z.string().min(1).openapi({ example: 'New post on the blog' }),
    permalink: z
      .string()
      .url()
      .optional()
      .openapi({
        example: 'https://example.com/posts/123',
        description:
          'Optional canonical URL. When present, rendered as the last line of the Text card.',
      }),
    caption: z.string().optional().openapi({ example: 'A short summary.' }),
    media: z
      .array(MediaItem)
      .max(10)
      .optional()
      .openapi({
        description:
          'Ordered list of media items (mixed image/* and video/* allowed, up to 10). Omitted or [] produces a text-only Post.',
      }),
  })
  .openapi('PostBody');

export const PostResponse = z
  .object({
    ok: z.literal(true),
    project: z.string().openapi({ example: 'blog' }),
    mediaCount: z.number().int().nonnegative().openapi({
      description: 'Number of Media items that were sent as part of the Album.',
    }),
  })
  .openapi('PostResponse');

export const HealthResponse = z
  .object({
    ok: z.literal(true),
    paired: z.boolean(),
    projects: z.number().int().nonnegative(),
  })
  .openapi('Health');

export const PermittedGroup = z
  .object({
    jid: GroupJid,
    subject: z.string().nullable().openapi({
      description:
        "Human-readable WhatsApp group name. null when the bot isn't paired or the JID isn't in the live group list yet.",
    }),
  })
  .openapi('PermittedGroup');

export const PermittedGroupsResponse = z
  .object({ groups: z.array(PermittedGroup) })
  .openapi('PermittedGroups');

export const GroupRef = z.object({ groupJid: GroupJid }).openapi('GroupRef');

export const GroupCreateBody = z
  .object({
    subject: z.string().trim().min(1).max(100).openapi({ example: 'Launch crew' }),
    participants: z
      .array(ParticipantId)
      .max(20)
      .default([])
      .openapi({
        description:
          'Optional members to add after creation (max 20). Phone numbers or user JIDs.',
      }),
    announce: z.boolean().default(false).openapi({
      description: 'When true, set the new group to announcement-only (admins post).',
    }),
    description: z.string().max(512).optional().openapi({ example: 'Coordination for the launch.' }),
  })
  .openapi('GroupCreateBody');

export const AddParticipantsBody = z
  .object({
    groupJid: GroupJid,
    participants: z.array(ParticipantId).min(1).max(20),
  })
  .openapi('AddParticipantsBody');

export const RemoveParticipantsBody = z
  .object({
    groupJid: GroupJid,
    participants: z.array(ParticipantId).min(1).max(20),
  })
  .openapi('RemoveParticipantsBody');

export const GroupSettingBody = z
  .object({
    groupJid: GroupJid,
    setting: z
      .enum(['announcement', 'not_announcement', 'locked', 'unlocked'])
      .openapi({ example: 'announcement' }),
  })
  .openapi('GroupSettingBody');

export const GroupSubjectBody = z
  .object({
    groupJid: GroupJid,
    subject: z.string().trim().min(1).max(100).openapi({ example: 'Launch crew' }),
  })
  .openapi('GroupSubjectBody');

export const GroupDescriptionBody = z
  .object({
    groupJid: GroupJid,
    description: z.string().max(512).openapi({
      example: 'Coordination for the launch.',
      description: 'Pass "" to clear the description.',
    }),
  })
  .openapi('GroupDescriptionBody');

export const GroupCreateResponse = z
  .object({
    ok: z.literal(true),
    groupJid: GroupJid,
    subject: z.string(),
    inviteCode: z.string().nullable(),
    inviteLink: z.string().nullable(),
    participants: z.array(ParticipantResult),
    settings: z.object({ announce: z.boolean() }),
    warnings: z.array(z.string()),
  })
  .openapi('GroupCreateResponse');

export const ParticipantsResponse = z
  .object({
    ok: z.literal(true),
    results: z.array(ParticipantResult),
  })
  .openapi('ParticipantsResponse');

export const InviteResponse = z
  .object({
    ok: z.literal(true),
    code: z.string().nullable(),
    link: z.string().nullable(),
  })
  .openapi('InviteResponse');

export const SettingResponse = z
  .object({
    ok: z.literal(true),
    setting: z.enum(['announcement', 'not_announcement', 'locked', 'unlocked']),
  })
  .openapi('SettingResponse');

export const LeaveResponse = z
  .object({
    ok: z.literal(true),
    leftGroup: GroupJid,
    removedFromProject: z.boolean(),
    note: z.string(),
  })
  .openapi('LeaveResponse');

// Communities are @g.us JIDs, so they reuse GroupJid and the same
// permission model as groups. create endpoints self-grant after creation.

export const CommunityCreateBody = z
  .object({
    subject: z.string().trim().min(1).max(100).openapi({ example: 'Launch HQ' }),
    description: z.string().max(512).optional().openapi({ example: 'Hub for all launch coordination.' }),
  })
  .openapi('CommunityCreateBody');

export const CommunityRef = z
  .object({ communityJid: GroupJid })
  .openapi('CommunityRef');

export const CommunityCreateGroupBody = z
  .object({
    parentJid: GroupJid,
    subject: z.string().trim().min(1).max(100).openapi({ example: 'Launch crew' }),
    participants: z
      .array(ParticipantId)
      .max(20)
      .default([])
      .openapi({
        description:
          'Optional members to add after creation (max 20). Phone numbers or user JIDs.',
      }),
    announce: z.boolean().default(false).openapi({
      description: 'When true, set the new subgroup to announcement-only (admins post).',
    }),
    description: z.string().max(512).optional().openapi({ example: 'Coordination for the launch.' }),
  })
  .openapi('CommunityCreateGroupBody');

export const CommunityLinkBody = z
  .object({
    parentJid: GroupJid,
    groupJid: GroupJid,
  })
  .openapi('CommunityLinkBody');

export const CommunityCreateResponse = z
  .object({
    ok: z.literal(true),
    communityJid: GroupJid,
    subject: z.string(),
    inviteCode: z.string().nullable(),
    inviteLink: z.string().nullable(),
    warnings: z.array(z.string()),
  })
  .openapi('CommunityCreateResponse');

export const CommunityCreateGroupResponse = z
  .object({
    ok: z.literal(true),
    groupJid: GroupJid,
    parentJid: GroupJid,
    subject: z.string(),
    inviteCode: z.string().nullable(),
    inviteLink: z.string().nullable(),
    participants: z.array(ParticipantResult),
    settings: z.object({ announce: z.boolean() }),
    warnings: z.array(z.string()),
  })
  .openapi('CommunityCreateGroupResponse');

export const CommunityLinkResponse = z
  .object({
    ok: z.literal(true),
    linked: z.literal(true),
    groupJid: GroupJid,
    parentJid: GroupJid,
  })
  .openapi('CommunityLinkResponse');

export const CommunityUnlinkResponse = z
  .object({
    ok: z.literal(true),
    unlinked: z.literal(true),
    groupJid: GroupJid,
    parentJid: GroupJid,
  })
  .openapi('CommunityUnlinkResponse');

export const CommunityListResponse = z
  .object({
    ok: z.literal(true),
    communities: z.array(
      z.object({
        jid: GroupJid,
        subject: z.string().nullable(),
        size: z.number().int().nullable(),
        permitted: z.boolean(),
      })
    ),
  })
  .openapi('CommunityListResponse');

export const CommunitySubgroupsResponse = z
  .object({
    ok: z.literal(true),
    communityJid: z.string(),
    isCommunity: z.boolean(),
    subgroups: z.array(
      z.object({
        id: z.string(),
        subject: z.string().optional(),
        creation: z.number().optional(),
        owner: z.string().optional(),
        size: z.number().int().optional(),
      })
    ),
  })
  .openapi('CommunitySubgroupsResponse');

export const CommunityMetadataResponse = z
  .object({
    ok: z.literal(true),
    jid: z.string(),
    subject: z.string().nullable(),
    desc: z.string().nullable(),
    isCommunity: z.boolean(),
    linkedParent: z.string().nullable(),
    announce: z.boolean(),
    size: z.number().int().nullable(),
  })
  .openapi('CommunityMetadataResponse');

// DM is opt-in / low-volume only — the recommended distribution path
// remains an invite-link group Post. Server-side safeguards (jitter +
// caps) are NOT settable from the request: no jitter/cap fields are
// accepted here, and unknown fields are stripped by Zod's default
// object behaviour so a caller can never speed up or raise the limits.

const RecipientId = z
  .string()
  .min(1)
  .openapi({
    example: '6191234567',
    description:
      'Phone number (digits, any formatting) or an explicit user JID (@s.whatsapp.net or @lid). Normalized server-side; must be on the DM allowlist.',
  });

const DmText = z
  .string()
  .min(1)
  .max(4096)
  .openapi({ example: 'Hi — thanks for opting in.' });

export const DmBody = z
  .object({
    toJid: RecipientId,
    text: DmText,
  })
  .openapi('DmBody');

export const DmBatchBody = z
  .object({
    recipients: z
      .array(RecipientId)
      .min(1)
      .max(50)
      .openapi({
        description:
          'Up to 50 recipients. Non-allowlisted recipients are skipped, not sent. Sends happen in the background with server-side jitter — nothing is sent synchronously and the rate cannot be raised by the caller.',
      }),
    text: DmText,
  })
  .openapi('DmBatchBody');

export const DmResultResponse = z
  .object({
    ok: z.literal(true),
    toJid: z.string(),
    status: z.literal('sent'),
  })
  .openapi('DmResultResponse');

export const DmBatchResponse = z
  .object({
    ok: z.literal(true),
    batchId: z.string(),
    enqueued: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    skipped: z.array(
      z.object({ jid: z.string(), reason: z.string() })
    ),
  })
  .openapi('DmBatchResponse');

export const DmStatusResponse = z
  .object({
    paused: z.boolean(),
    pauseReason: z.string().nullable(),
    pending: z.number().int().nonnegative(),
    sentLastMin: z.number().int().nonnegative(),
    sentLastDay: z.number().int().nonnegative(),
    caps: z.object({
      perMin: z.number().int().nonnegative(),
      perDay: z.number().int().nonnegative(),
    }),
    batch: z
      .object({
        batchId: z.string(),
        pending: z.number().int().nonnegative(),
        sent: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .openapi('DmStatusResponse');

export const DmStatusQuery = z.object({
  batchId: z
    .string()
    .optional()
    .openapi({ param: { name: 'batchId', in: 'query' } }),
});

export const DmResumeResponse = z
  .object({
    ok: z.literal(true),
    resumed: z.literal(true),
    status: DmStatusResponse,
  })
  .openapi('DmResumeResponse');

export const DmCancelBody = z
  .object({ batchId: z.string().min(1) })
  .openapi('DmCancelBody');

export const DmCancelResponse = z
  .object({
    ok: z.literal(true),
    cancelled: z.number().int().nonnegative(),
  })
  .openapi('DmCancelResponse');
