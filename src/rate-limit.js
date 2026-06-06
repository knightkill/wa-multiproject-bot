// `x-forwarded-for` is client-supplied and trivially spoofable, so trusting it
// would let an attacker mint unlimited buckets. Behind Fly we use the proxy's
// fly-client-ip (a client cannot override it); behind another reverse proxy,
// opt into XFF with TRUST_XFF=true; otherwise fall back to the socket address.
const TRUST_XFF = process.env.TRUST_XFF === 'true';

export function clientIp(c) {
  const flyClientIp = c.req.header('fly-client-ip');
  if (flyClientIp) return flyClientIp;
  if (TRUST_XFF) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return c.env?.incoming?.socket?.remoteAddress || 'unknown';
}

// Fixed-window per-IP limiter. The deployment runs as a single Fly machine,
// so process-local counters need no shared store to coordinate.
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return async (c, next) => {
    const now = Date.now();
    const id = clientIp(c);
    let record = hits.get(id);
    if (!record || now >= record.resetAt) {
      record = { count: 0, resetAt: now + windowMs };
      hits.set(id, record);
    }
    record.count += 1;
    if (record.count > max) {
      c.header('Retry-After', String(Math.ceil((record.resetAt - now) / 1000)));
      return c.json({ error: 'rate limit exceeded' }, 429);
    }
    if (hits.size > 10_000) {
      for (const [key, value] of hits) {
        if (now >= value.resetAt) hits.delete(key);
      }
    }
    await next();
  };
}
