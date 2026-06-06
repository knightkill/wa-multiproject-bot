import crypto from 'node:crypto';

// 1:1 DM sender with MANDATORY server-side safeguards.
//
// Bulk DMing is the fastest way to get a number restricted, so the recommended
// distribution path is an invite-link GROUP post; DM is for low-volume / opt-in
// only. Every send is gated by a recipient allowlist (enforced in the route),
// spaced by per-message jitter, and capped per minute and per day. None of those
// safeguards are settable by the API caller — they live here, server-side, and
// can only be tuned via env / the config arg.

// Mirror the crypto id idiom in db.js (mintToken): random 32 bytes, base64url.
function makeBatchId() {
  return crypto.randomBytes(32).toString('base64url');
}

// True when an error looks like a WhatsApp account restriction — the signal we
// use to auto-pause so we stop digging the hole deeper.
export function classifyRestriction(err) {
  if (!err) return false;
  const status = err?.output?.statusCode ?? err?.statusCode ?? err?.status;
  if (status === 401 || status === 403 || status === 423 || status === 429) {
    return true;
  }
  const msg = String(err?.message ?? err);
  return /forbidden|rate-?overlimit|not-?authorized|restricted|locked|conflict|too many/i.test(
    msg
  );
}

export function createDmSender({ db, getSock, isPaired, logger, config = {} }) {
  const log = logger ?? { info() {}, warn() {}, error() {} };

  const cfg = {
    jitterMinMs: config.jitterMinMs ?? Number(process.env.DM_JITTER_MIN_MS ?? 60000),
    jitterMaxMs: config.jitterMaxMs ?? Number(process.env.DM_JITTER_MAX_MS ?? 180000),
    capPerMin: config.capPerMin ?? Number(process.env.DM_CAP_PER_MIN ?? 1),
    capPerDay: config.capPerDay ?? Number(process.env.DM_CAP_PER_DAY ?? 30),
    pollMs: config.pollMs ?? 5000,
    maxBatch: config.maxBatch ?? 50,
  };

  let timer = null;

  // Serialize ALL sends (immediate sendNow + queued processOnce) through one
  // async critical section so the cap read and the markDmSent write are atomic.
  // Without this, concurrent POST /v1/dm calls all read the same pre-send count
  // (TOCTOU) and every one passes the cap check before any marks sent — blowing
  // DM_CAP_PER_MIN. The lock makes the per-minute cap hold even under a tight
  // concurrent loop, which is the headline safeguard.
  let _lock = Promise.resolve();
  function withLock(fn) {
    const result = _lock.then(fn, fn);
    _lock = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  function caps() {
    const now = Date.now();
    return {
      perMin: db.countDmSentSince(now - 60000),
      perDay: db.countDmSentSince(now - 86400000),
    };
  }

  function restrictionReason(err) {
    const status = err?.output?.statusCode ?? err?.statusCode ?? err?.status;
    return `whatsapp restriction: ${status ?? ''} ${String(err?.message ?? err)}`.trim();
  }

  // Immediate single-DM path (POST /v1/dm). Throws an Object with a `code` the
  // route maps to an HTTP status. Still goes through the queue + caps so the
  // synchronous path can never bypass the safeguards.
  async function sendNow(toJid, body) {
    return withLock(async () => {
      const state = db.getDmState();
      if (state.paused) {
        throw { code: 'paused', reason: state.pauseReason };
      }
      const { perMin, perDay } = caps();
      if (perMin >= cfg.capPerMin) {
        throw { code: 'cap', scope: 'minute', detail: `per-minute cap ${cfg.capPerMin} reached` };
      }
      if (perDay >= cfg.capPerDay) {
        throw { code: 'cap', scope: 'day', detail: `per-day cap ${cfg.capPerDay} reached` };
      }

      // Fresh batch id per immediate send, so the (batch, jid) row is unique and
      // we can locate exactly the row we just inserted regardless of any backlog.
      const batchId = makeBatchId();
      const idempotencyKey = `${batchId}:${toJid}`;
      db.enqueueDm({ batchId, toJid, body, idempotencyKey });
      const rows = db.listDmQueue({ batchId, status: 'pending', limit: 1 });
      const row = rows[0];

      try {
        await getSock().sendMessage(toJid, { text: body });
        db.markDmSent(row.id);
        return { status: 'sent' };
      } catch (err) {
        if (classifyRestriction(err)) {
          const reason = restrictionReason(err);
          db.setDmPaused(reason);
          // Leave the row pending (do NOT markDmFailed) so it resumes after the
          // operator un-pauses; the unique idempotency_key prevents a double-send.
          // Matches the queue path + ADR 0006.
          log.warn({ err, toJid }, 'dm restricted — auto-paused, item left pending');
          throw { code: 'restricted', detail: reason };
        }
        db.markDmFailed(row.id, String(err?.message ?? err));
        log.error({ err, toJid }, 'dm send failed');
        throw { code: 'send_failed', detail: String(err?.message ?? err) };
      }
    });
  }

  // Queue items for background delivery (POST /v1/dm/batch). Nothing is sent
  // synchronously; the loop drains them with jitter.
  function enqueueBatch(items, batchId) {
    const id = batchId ?? makeBatchId();
    // Enforce maxBatch server-side too (defense-in-depth; the route schema also
    // caps recipients, but the engine must not trust that).
    const capped = items.slice(0, cfg.maxBatch);
    const rejected = items.length - capped.length;
    let enqueued = 0;
    let duplicates = 0;
    for (const it of capped) {
      const idempotencyKey = `${id}:${it.toJid}`;
      const { inserted } = db.enqueueDm({
        batchId: id,
        toJid: it.toJid,
        body: it.body,
        idempotencyKey,
      });
      if (inserted) enqueued += 1;
      else duplicates += 1;
    }
    return { batchId: id, enqueued, duplicates, rejected };
  }

  // One queue step. Drives the background loop and is directly callable by
  // tests. Returns a status object describing what happened.
  async function processOnce() {
    return withLock(async () => {
      const state = db.getDmState();
      if (state.paused) {
        return { status: 'paused', reason: state.pauseReason };
      }

      const { perMin, perDay } = caps();
      if (perMin >= cfg.capPerMin) return { status: 'throttled', scope: 'minute' };
      if (perDay >= cfg.capPerDay) return { status: 'throttled', scope: 'day' };

      const item = db.nextPendingDm();
      if (!item) return { status: 'idle' };

      if (!isPaired()) return { status: 'not_paired' };

      try {
        await getSock().sendMessage(item.toJid, { text: item.body });
        db.markDmSent(item.id);
        return { status: 'sent', id: item.id };
      } catch (err) {
        if (classifyRestriction(err)) {
          const reason = restrictionReason(err);
          db.setDmPaused(reason);
          // Leave the item pending so it resumes after unpause; the unique
          // idempotency_key prevents a double-send.
          log.warn({ err, id: item.id }, 'dm restricted — auto-paused, item left pending');
          return { status: 'paused', reason };
        }
        const msg = String(err?.message ?? err);
        db.markDmFailed(item.id, msg);
        log.error({ err, id: item.id }, 'dm send failed');
        return { status: 'failed', id: item.id, error: msg };
      }
    });
  }

  function jitterDelay() {
    const span = Math.max(0, cfg.jitterMaxMs - cfg.jitterMinMs);
    return cfg.jitterMinMs + Math.floor(Math.random() * (span + 1));
  }

  function schedule(delay) {
    timer = setTimeout(tick, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    let delay = cfg.pollMs;
    try {
      const result = await processOnce();
      if (result.status === 'sent') delay = jitterDelay();
    } catch (err) {
      log.error({ err }, 'dm queue tick failed');
    }
    schedule(delay);
  }

  // Self-rescheduling timer loop. Pending rows are picked up automatically on
  // boot (resumable).
  function start() {
    if (timer) return;
    schedule(cfg.pollMs);
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function status() {
    const now = Date.now();
    const state = db.getDmState();
    return {
      paused: state.paused,
      pauseReason: state.pauseReason,
      pending: db.pendingDmCount(),
      sentLastMin: db.countDmSentSince(now - 60000),
      sentLastDay: db.countDmSentSince(now - 86400000),
      caps: { perMin: cfg.capPerMin, perDay: cfg.capPerDay },
    };
  }

  return { start, stop, processOnce, sendNow, enqueueBatch, status, classifyRestriction };
}
