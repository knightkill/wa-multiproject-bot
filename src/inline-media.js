import { DM_MEDIA_MAX_BYTES } from './schemas/project.js';

// Inline (base64) media shared by POST /v1/dm and POST /v1/post/file. The
// schema has already restricted the mimetype; this decodes and size-checks,
// and builds the Baileys content object, so the two routes cannot drift.

export class InvalidMediaError extends Error {}

export function decodeInlineMedia(input) {
  const buffer = Buffer.from(input.data, 'base64');
  if (buffer.length === 0) throw new InvalidMediaError('empty or not base64');
  if (buffer.length > DM_MEDIA_MAX_BYTES) throw new InvalidMediaError(`over ${DM_MEDIA_MAX_BYTES} bytes`);
  return { buffer, mimetype: input.mimetype, filename: input.filename };
}

export function mediaKind(media) {
  return media.mimetype.startsWith('image/') ? 'image' : 'document';
}

// What gets logged in place of the file: a kind marker plus the caption.
export function mediaLogLine(media, caption) {
  return `[${mediaKind(media)}] ${caption ?? ''}`.trim();
}

export function mediaContent(media, caption) {
  const withCaption = caption ? { caption } : {};
  if (mediaKind(media) === 'image') {
    return { image: media.buffer, mimetype: media.mimetype, ...withCaption };
  }
  return {
    document: media.buffer,
    mimetype: media.mimetype,
    fileName: media.filename ?? 'document.pdf',
    ...withCaption,
  };
}
