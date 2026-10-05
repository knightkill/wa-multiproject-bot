import fs from 'node:fs';

// Serve one captured message's media file, downloading it via `saveMedia`
// first if it was not saved on arrival. Shared by the admin and reader routes;
// callers do their own auth and any chat-scope check before calling this.
export async function serveInboundMedia(c, { id, saveMedia, log }) {
  try {
    const media = await saveMedia(id);
    const body = fs.readFileSync(media.path);
    return new Response(body, {
      headers: {
        'Content-Type': (media.mime ?? 'application/octet-stream').split(';')[0],
        'Content-Length': String(body.length),
      },
    });
  } catch (err) {
    log.warn({ err: String(err?.message ?? err), id }, 'media fetch failed');
    return c.json({ error: 'media unavailable', detail: String(err?.message ?? err) }, 410);
  }
}

export function parseMediaId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id >= 1 ? id : null;
}
