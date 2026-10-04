import { BufferJSON } from '@whiskeysockets/baileys';

const MEDIA_BRANCHES = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
];

const SKIP_BRANCHES = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'reactionMessage',
]);

export function normalizeInbound(waMsg) {
  if (!waMsg?.key || !waMsg.message) return null;
  const { key, message, messageTimestamp } = waMsg;

  const branches = Object.keys(message).filter((k) => !SKIP_BRANCHES.has(k));
  if (branches.length === 0) return null;

  let text = null;
  let mediaType = null;
  let quotedWaId = null;
  let mime = null;

  if (message.conversation) {
    text = message.conversation;
  } else if (message.extendedTextMessage) {
    text = message.extendedTextMessage.text ?? null;
    quotedWaId = message.extendedTextMessage.contextInfo?.stanzaId ?? null;
  }

  for (const [branch, type] of MEDIA_BRANCHES) {
    if (message[branch]) {
      mediaType = type;
      mime = message[branch].mimetype ?? null;
      if (!text && message[branch].caption) text = message[branch].caption;
      quotedWaId = quotedWaId ?? message[branch].contextInfo?.stanzaId ?? null;
      break;
    }
  }

  if (text == null && mediaType == null) return null;

  const tsRaw = messageTimestamp;
  const tsSeconds =
    typeof tsRaw === 'number'
      ? tsRaw
      : typeof tsRaw?.toNumber === 'function'
      ? tsRaw.toNumber()
      : Number(tsRaw ?? 0);

  return {
    waId: key.id,
    chatJid: key.remoteJid,
    senderJid: key.participant ?? key.remoteJid,
    fromMe: Boolean(key.fromMe),
    timestamp: tsSeconds > 0 ? tsSeconds * 1000 : Date.now(),
    text,
    mediaType,
    quotedWaId,
    mime,
    // Everything needed to download the media later (keys, CDN path).
    raw: mediaType ? JSON.stringify(waMsg, BufferJSON.replacer) : null,
  };
}
