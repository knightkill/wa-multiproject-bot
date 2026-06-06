import { z } from '@hono/zod-openapi';

export const GroupJid = z
  .string()
  .regex(/^[^@\s]+@g\.us$/, 'must be a WhatsApp group JID, e.g. 1234567890-1612345678@g.us')
  .openapi({ example: '1234567890-1612345678@g.us' });

export const ChatJid = z
  .string()
  .regex(
    /^[^@\s]+@(g\.us|s\.whatsapp\.net|lid)$/,
    'must be a WhatsApp chat JID (group, person, or LID)'
  )
  .openapi({ example: '6191234567@s.whatsapp.net' });

export const MediaType = z
  .string()
  .regex(/^(image|video)\/[A-Za-z0-9.+-]+$/, 'only image/* or video/* mimetypes are accepted')
  .openapi({ example: 'image/jpeg' });

export const ErrorEnvelope = z
  .object({
    error: z.string().openapi({ example: 'unauthorized' }),
    detail: z.string().optional(),
  })
  .openapi('Error');

export const OkResponse = z
  .object({ ok: z.literal(true) })
  .openapi('Ok');

export { z };
