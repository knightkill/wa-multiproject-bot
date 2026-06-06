# 1:1 DMs ship only behind un-bypassable server-side throttling

An early bulk-DM experiment got a paired number restricted. The shape of
the incident matters: a few dozen 1:1 messages were fanned out over the
WhatsApp-Web protocol in quick succession, only a couple actually
delivered, and the account was flagged shortly after. In the same window,
bulk participant-adds (the force-add path the group API already warns
against) disconnected the session several times. The lesson is not "don't
add DMs" — the operator wants a 1:1 path for genuinely low-volume, opt-in
messages — it is that a 1:1 send path with no governor is a ban button,
and that the governor must live where the caller cannot reach it.

So WA-3 adds a Direct message capability, but every safeguard is
**server-side and un-bypassable**. The send throttle — a per-message
jitter delay (`DM_JITTER_MIN_MS` default 60000, `DM_JITTER_MAX_MS`
default 180000) plus a per-minute cap (`DM_CAP_PER_MIN` default 1) and
a per-day cap (`DM_CAP_PER_DAY` default 30) — is sourced only from the
process environment, never from the request body or query string. The
zod schemas for `/v1/dm` and `/v1/dm/batch` accept exactly `toJid` /
`recipients` and `text`, and reject or ignore everything else: there is
no field a caller can set to speed up delivery, raise a cap, or shrink
the jitter. A Project that wants to blast 200 DMs cannot — the queue
will drip them at one per minute (default) regardless of how the call
is shaped, and stop entirely at 30 a day. This is deliberate
asymmetry: the caller expresses intent, the server decides pace.

The pace is enforced by a **resumable, idempotent SQLite queue**
(`dm_queue`) rather than synchronous fan-out. `/v1/dm/batch` does not
send anything synchronously — it enqueues rows and returns immediately;
a background loop in `src/dmQueue.js` drains them one at a time, waiting
a fresh jitter delay after each successful send. Every row carries an
`idempotency_key` (`batchId:toJid`) with a UNIQUE constraint, so a
retried batch, a double-submit, or a restart mid-drain can never send
the same message twice — `enqueueDm` is `INSERT OR IGNORE` and reports
duplicates back. Because the queue is on the Fly volume, pending rows
survive a restart and the loop simply picks them up on boot. The
immediate single-DM path (`/v1/dm`, `sendNow`) still routes through the
same table and the same caps, so even a one-off send is counted against
the minute/day budget and is subject to the pause state.

The queue is **restriction-aware**: it pauses itself the moment
WhatsApp signals trouble. `classifyRestriction` inspects each send
error and treats it as a restriction when the message matches
`/forbidden|rate-?overlimit|not-?authorized|restricted|locked|conflict|too many/i`
or the status is 401/403/423/429. On a match the queue calls
`setDmPaused(reason)` and **leaves the offending row pending** — it does
not mark it failed — so once the operator un-pauses, the same message
resumes and the idempotency key prevents a double-send. Pause is a
singleton row (`dm_state`, id=1): once tripped, `processOnce` short-
circuits to `{status:"paused"}` and `sendNow` throws `code:"paused"`
(surfaced as `423` to the caller) until an operator explicitly calls
`POST /admin/api/dm/resume` (admin-scoped). There is no auto-resume timer; coming back is a
human decision, because the incident showed the account needs to actually
cool off, not just wait out a backoff.

Who may be DMed is gated by an **opt-in DM allowlist** (`dm_allowed`),
deliberately distinct from the group Allowlist. A `/v1/dm` to a JID not
in `dm_allowed` returns `403 recipient not permitted (not in DM
allowlist)`; `/v1/dm/batch` partitions its recipients and reports the
non-allowed ones under `skipped[]` rather than failing the call. The
allowlist is operator-managed via `/admin/api/dm-allowlist`, mirroring
the group-allowlist admin endpoints. This is a second, orthogonal brake
to the throttle: the throttle limits *how fast* and *how many*, the
allowlist limits *to whom*. Both must pass.

Finally, the **default distribution path stays the invite-link group
Post** (WA-1). DM is documented as the opt-in, low-volume exception with
a prominent ban-risk warning, not the recommended channel. If you have
something to push to many people, you post it once to a Group and share
the invite link; you do not DM them. The DM surface exists for the cases
where a 1:1, consented message is genuinely the right tool — and even
then it drips.

The cost of all this is that DMs are slow by construction and cannot be
made fast. That is the point. Revisit the caps and jitter defaults only
after the account's standing has recovered and only by changing the
environment, never by widening what the request body accepts.
