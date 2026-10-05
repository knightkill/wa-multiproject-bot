# wa-multiproject-bot

Single-paired-phone, multi-project WhatsApp bot. One Baileys session forwards messages from any number of your projects (Blog, Shop, future ones) to their respective WhatsApp groups. Projects, tokens, and group access are managed through a browser admin UI at `https://your-domain.example/admin` — no SSH or file editing required.

## Disclaimer

This project uses [Baileys](https://github.com/WhiskeySockets/Baileys), an
unofficial, reverse-engineered implementation of the WhatsApp Web protocol.

- **It is not affiliated with, endorsed by, or connected to WhatsApp LLC or Meta
  Platforms, Inc.** "WhatsApp" is a trademark of its respective owner, used here
  only nominatively to describe interoperability.
- Using it **violates WhatsApp's Terms of Service**, and the paired phone number
  **can be banned**. Run it only on a number you are willing to lose.
- **No bulk, automated, or unsolicited messaging**, spam, or stalkerware. You
  assume all risk and responsibility for how you use it.

## Architecture

```
Blog Worker  ──Bearer blog-token──┐
                                  ├──>  this bot (Fly) ──Baileys──>  WhatsApp groups
Shop Worker  ──Bearer shop-token──┘     (token + body.groupJid → target)
```

- One Fly app, one paired phone, one shared Baileys session
- SQLite at `/data/wp.db` (on the Fly volume) holds projects, allowed groups, and the message log
- Each project token grants access to a **set** of allowed group JIDs (subset of the global allowlist); `POST /v1/post` body specifies which group to send to
- Public API docs (Redoc, generated from zod schemas) at `https://your-domain.example/docs`

## Why a separate repo

The bot started single-project, embedded in one app. Extracted into its own repo once a second consumer needed the same delivery channel — multiplexing one bot across N projects keeps the cost flat (one small VM total, not one per project), survives one pairing flow instead of N, and lets you rotate per-project tokens without touching the bot itself.

## Caveats

- **WhatsApp ToS:** Baileys uses the unofficial WhatsApp Web protocol. The phone number paired here risks a ban. Accepted for personal use.
- **Cost:** a small shared-cpu-1x VM plus a 1 GB volume runs a few dollars a month, regardless of how many projects use it. Verify current pricing at https://fly.io/pricing/.
- **One device:** WhatsApp's multi-device cap is currently four linked devices per number. Pair this bot from a phone you'll keep on a stable number.
- **Media size:** WhatsApp non-business video upload limit is ~16 MB. The bot pre-flights oversized video via HEAD and transparently transcodes >16 MB sources to a deliverable MP4 (≤720p H.264, dynamic bitrate) using in-process ffmpeg — see "Large-video transcoding" below. iPhone `.mov` (QuickTime) sources are accepted; they're re-encoded.
- **Token blast radius:** a project token can post to any group in its allowed set. Keep allowed sets minimal per project.
- **DMs are the highest ban risk.** Bulk-DMing is what gets numbers restricted. 1:1 DMs (`/v1/dm*`) ship only behind a mandatory, un-bypassable server-side throttle (per-minute/per-day caps + jitter), a restriction auto-pause, and an opt-in DM allowlist that is ON by default. Prefer invite-link group posts; reserve DMs for low-volume opt-in. See [Direct messages](#direct-messages-throttled).

## First-time deploy

```bash
# 1. Auth flyctl
fly auth login

# 2. From the repo root, create the app + volume
cd wa-multiproject-bot
fly apps create your-app-name
fly volumes create wa_data --region iad --size 1 --yes

# 3. Generate an admin token and set it as a secret
ADMIN_TOKEN=$(openssl rand -hex 32)
fly secrets set ADMIN_TOKEN="$ADMIN_TOKEN"
echo "ADMIN_TOKEN (save this): $ADMIN_TOKEN"

# 4. First deploy — bot boots with an empty SQLite DB
fly deploy

# 5. Pair your phone — watch logs for "QR refreshed"
fly logs &
# /qr needs the admin token; save the PNG and open it (never put the token in a browser URL):
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" https://your-app-name.fly.dev/qr -o qr.png && open qr.png
# scan with: WhatsApp → Settings → Linked Devices → Link a Device

# 6. Point the custom hostname at Fly
#    DNS:  CNAME  your-domain.example  →  your-app-name.fly.dev
#    Fly auto-provisions the TLS cert on the first request.
open https://your-domain.example/admin

# 7. In the admin UI:
#    - Paste the ADMIN_TOKEN you generated above
#    - Allowlist tab: tick the WhatsApp groups that should be selectable
#    - Projects tab: create one project per consumer (blog, shop, …),
#      pick which allowlisted groups it can post to, copy the token ONCE
#      and paste it into the consumer's WHATSAPP_BOT_TOKEN secret.
```

## Wiring a consumer

Each project's worker calls `POST /v1/post` with its own bearer token, specifying which of its allowed groups to send to. Example (Cloudflare Worker):

```ts
await fetch(`${env.WHATSAPP_BOT_URL}/v1/post`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.WHATSAPP_BOT_TOKEN}`,
  },
  body: JSON.stringify({
    groupJid: '120363xxxxxxxxxxxx@g.us',  // must be in this project's allowed set
    title: 'Post title',
    caption: 'optional caption',
    permalink: 'https://example.com/post/123',
    mediaUrl: 'https://example.com/media.jpg',  // optional
    mediaType: 'image/jpeg',                     // required if mediaUrl; must match image/* or video/*
  }),
});
```

Full request/response schema, error codes, and examples: `https://your-domain.example/docs`.

`WHATSAPP_BOT_URL` = `https://your-domain.example`
`WHATSAPP_BOT_TOKEN` = the per-project token from the admin UI

## Adding a new project

1. Open `https://your-domain.example/admin`, sign in with `ADMIN_TOKEN`
2. (If needed) Allowlist tab: tick any new target groups, hit Save
3. Projects tab: click "+ New project", pick allowed groups, hit Save
4. Copy the token from the one-time modal into the consumer's secret store

No redeploy or SSH needed.

## Rotating a token

In the Projects tab, click "Rotate token" on the project. Copy the new token, paste it into the consumer's secret. The old token stops working immediately.

## Group management

Beyond posting, a project token can create and run its own WhatsApp groups via nine `POST /v1/groups/*` endpoints (all body-based, all 503 when the bot isn't paired):

| Endpoint | Body | Does |
|---|---|---|
| `/v1/groups/create` | `{ subject, participants?, announce?, description? }` | Creates a group, then **grants this project access**: appends the new JID to the global allowlist *and* to the project's group access so it can post/manage immediately. Returns the invite link. |
| `/v1/groups/participants/add` | `{ groupJid, participants }` | Adds up to 20 participants; returns a per-JID status. |
| `/v1/groups/participants/remove` | `{ groupJid, participants }` | Removes up to 20 participants. |
| `/v1/groups/invite/code` | `{ groupJid }` | Returns the current invite code + `https://chat.whatsapp.com/<code>` link. |
| `/v1/groups/invite/revoke` | `{ groupJid }` | Rotates the invite code (old link dies), returns the new one. |
| `/v1/groups/setting` | `{ groupJid, setting }` | `announcement`/`not_announcement` (admins-only posting) or `locked`/`unlocked` (admins-only info edit). |
| `/v1/groups/subject` | `{ groupJid, subject }` | Renames the group. |
| `/v1/groups/description` | `{ groupJid, description }` | Sets/clears the description (`""` clears). |
| `/v1/groups/leave` | `{ groupJid }` | Leaves the group and removes it from this project's access. The global allowlist is left unchanged — prune it via the admin UI if you want. |

Every endpoint except `create` enforces the same guard as `POST /v1/post`: the `groupJid` must be in this project's access × the global allowlist, else 403. `create` is the exception — there's no group to check against yet, so it creates first and grants access after.

**Invite-link-first.** Force-adding people who don't expect it is the behaviour WhatsApp flags for bans. `participants/add` returns per-JID statuses; a `403` (recipient privacy/blocked) or `408` (recently left) does *not* fail the whole batch — those JIDs come back with a `note` steering you to share the invite link instead. Prefer the link over the force-add.

Full request/response schemas and error codes: `https://your-domain.example/docs`.

### Community management

A project token can also build and run WhatsApp **Communities** — a parent group that holds linked sub-groups — via seven `POST`/`GET` `/v1/communities/*` endpoints (body-based like group management, all 503 when the bot isn't paired). **Requires Baileys 7.0** (`7.0.0-rc13`); the community socket methods don't exist on the 6.x line, so this whole subsystem ships with the version bump — see [`docs/adr/0005-community-support.md`](docs/adr/0005-community-support.md).

| Endpoint | Body | Does |
|---|---|---|
| `POST /v1/communities/create` | `{ subject, description? }` | Creates a community, then **grants this project access**: appends the new JID to the global allowlist *and* the project's group access. Returns the invite link. No pre-check (nothing to check yet). |
| `POST /v1/communities/create-group` | `{ parentJid, subject, participants?, announce?, description? }` | Creates a sub-group directly under `parentJid` (must be permitted), grants this project access to the new sub-group, then seeds up to 20 participants with per-JID status. Returns the invite link. |
| `POST /v1/communities/link` | `{ parentJid, groupJid }` | Links an existing group under a community. **Both** JIDs must be permitted (else 403 naming which one). |
| `POST /v1/communities/unlink` | `{ parentJid, groupJid }` | Unlinks a group from a community. **Both** JIDs must be permitted. |
| `GET /v1/communities` | — | Lists every community the paired account participates in, each annotated with `permitted`. Read-only discovery — never 403s. |
| `POST /v1/communities/subgroups` | `{ communityJid }` | Lists the groups linked under a community (`communityJid` must be permitted). |
| `POST /v1/communities/metadata` | `{ communityJid }` | Returns a community's subject, description, announce flag, size, and linked-parent (`communityJid` must be permitted). |

Same intersection guard as posting: every endpoint targeting an existing community/group requires the JID(s) in this project's access × the global allowlist, else 403. `create` and `create-group` are the exceptions — they create first and grant access after, exactly like `/v1/groups/create`. Linking requires the bot to be a community admin (a WhatsApp-side constraint; failures surface as 502).

Full request/response schemas and error codes: `https://your-domain.example/docs`.

## Direct messages (throttled)

> **⚠️ Ban risk — read before using.** Bulk-DMing is the fastest way to get a
> number restricted: an early experiment with this path had a test number
> flagged after only a few dozen attempted messages, most of which never
> delivered. DMs are the single highest-risk thing this bot can do.
> **The recommended distribution path is still an invite-link group post** —
> post once to a group and share the link. Use DMs only for genuinely
> low-volume, opt-in, 1:1 messages. The throttle below is mandatory — see
> [`docs/adr/0006-dm-throttling-safeguards.md`](docs/adr/0006-dm-throttling-safeguards.md).

A project token can send 1:1 DMs via `/v1/dm*`, but every safeguard is
**server-side and cannot be bypassed, sped up, or raised by the caller** —
there is no request-body or query field that touches the pace or the caps.

| Endpoint | Body | Does |
|---|---|---|
| `POST /v1/dm` | `{ toJid, text }` | Sends one DM **now** — but only if the recipient is on the DM allowlist (else 403) and the caps allow it. Routes through the same throttled queue. |
| `POST /v1/dm/batch` | `{ recipients[1..50], text }` | **Enqueues** DMs (nothing is sent synchronously); they drip out in the background under jitter. Non-allowlisted recipients come back under `skipped[]`. Returns `{ batchId, enqueued, duplicates, skipped }`. |
| `GET /v1/dm/status` | — (query `batchId?`) | Queue status: paused state, pending count, sent-last-minute / sent-last-day, the configured caps; with `batchId`, that batch's `{ pending, sent, failed, skipped }`. |
| `POST /admin/api/dm/resume` | `{}` | **Admin** un-pause after a restriction auto-pause (admin token, not a project token). There is no auto-resume by design. |
| `POST /v1/dm/cancel` | `{ batchId }` | Marks that batch's still-pending rows as `skipped` (error `cancelled`). |

**Server-side safeguards (none caller-controllable):**

- **Caps:** at most `DM_CAP_PER_MIN` DMs/minute (default **1**) and `DM_CAP_PER_DAY`/day (default **30**). Over-cap on `/v1/dm` → `429 dm cap reached`.
- **Jitter:** every queued send waits a random `DM_JITTER_MIN_MS`–`DM_JITTER_MAX_MS` (default **60s–180s**) before the next. Sourced only from the environment.
- **Restriction auto-pause:** if WhatsApp returns a restriction (status 401/403/423/429 or a matching error), the queue **pauses itself** and leaves the in-flight DM pending. `/v1/dm` then returns `423 dm sending paused` until an operator calls `/admin/api/dm/resume` (admin-scoped).
- **DM allowlist:** recipients must be on the opt-in DM allowlist (`dm_allowed`), managed by the operator at `PUT /admin/api/dm-allowlist` — a separate gate from the group allowlist. Not on it → 403 (single) or `skipped` (batch).
- **Resumable & idempotent:** the queue is SQLite-backed; pending rows survive a restart, and each row's idempotency key (`batchId:toJid`) means a retry, double-submit, or restart-mid-drain never double-sends.

Status codes for `POST /v1/dm`: `200` sent · `400` invalid recipient · `403` not on DM allowlist · `423` sending paused · `429` cap reached **or** WhatsApp restricted (auto-paused) · `502` send failed · `503` not paired.

Full request/response schemas and error codes: `https://your-domain.example/docs`.

## Inbound message capture

The bot can record messages from selected chats into SQLite for later retrieval
via the admin API — useful for archiving a group's posts or building a read model.

**This is opt-in per chat and off by default.** Nothing is captured unless you add
a chat to the *readable chats* list (admin UI → Readable chats, or
`PUT /admin/api/readable-chats`). Once a chat is readable, the bot stores each
incoming message's id, sender, timestamp, text, and media type — **not media
bytes** — in the `inbound_messages` table, capped at the most recent 10,000 rows.
Read them back with `GET /admin/api/inbound` (both endpoints require `ADMIN_TOKEN`).

> **Privacy:** for group chats this records other participants' messages. Only
> mark a chat readable where you have a legitimate reason and, where applicable,
> the participants' awareness. To stop capturing, remove the chat from the readable
> list; to purge, delete the rows from `inbound_messages`.

### Read-only reader token

A third credential tier lets an automated reader (e.g. a cloud agent) poll
inbound messages from a fixed set of chats without holding `ADMIN_TOKEN`.

| Env var        | Meaning |
|----------------|---------|
| `READER_TOKEN` | Bearer token for `/read/*` only. Feature is **off** (every `/read/*` request gets 401) if unset, shorter than 32 chars, or equal to `ADMIN_TOKEN`. Generate with `openssl rand -hex 32`; set as a secret. |
| `READER_CHATS` | Comma-separated chat JIDs the reader may see. Server-side allowlist; empty ⇒ the reader sees nothing. The same list applies to every account (`/read/*` and `/a/<name>/read/*`); a JID only matches in the account whose database captured it. |

- `GET /read/inbound` — same query params and response as `GET /admin/api/inbound`
  (`jid`, `since`, `fromMe`, `limit` → `{ messages, nextCursor }`), restricted in SQL
  to `READER_CHATS`, plus `sinceTs` (epoch ms, `timestamp >= sinceTs`) for stateless
  time-window polling. A `jid` outside the allowlist returns an empty list, not an error.
- `GET /read/inbound/:id/media` — the message's media file; 404 unless the message's
  chat is in `READER_CHATS`.

Both are rate-limited to 60/min per client IP and take the token from the
`Authorization: Bearer` header only. The reader token is rejected on every other
route, and `ADMIN_TOKEN` is rejected on `/read/*`, so the two tiers stay separately
auditable.

```sh
curl -H "Authorization: Bearer $READER_TOKEN" \
  "https://your-app-name.fly.dev/read/inbound?sinceTs=$(( ($(date +%s) - 3600) * 1000 ))"
```

## Routes

| Method | Path                              | Auth          | Purpose                                                |
|--------|-----------------------------------|---------------|--------------------------------------------------------|
| GET    | `/`                               | none          | Health: paired status + project count                  |
| GET    | `/qr`                             | `ADMIN_TOKEN` | PNG pairing QR — send the admin token as a Bearer header (404 once paired) |
| GET    | `/docs`                           | none          | Public Redoc-rendered Project API reference            |
| GET    | `/openapi.json`                   | none          | Project API OpenAPI 3.1 spec                           |
| POST   | `/v1/post`                        | project token | `{ groupJid, title, caption?, permalink?, media? }` (media = `[{ url, type }]`, up to 10) |
| GET    | `/v1/groups`                      | project token | List the groups this project may post to               |
| POST   | `/v1/groups/*`                    | project token | Group management — see [Group management](#group-management) |
| `*`    | `/v1/communities/*`               | project token | Community management — see [Community management](#community-management) |
| `*`    | `/v1/dm*`                         | project token | Throttled 1:1 DMs — see [Direct messages](#direct-messages-throttled) |
| GET    | `/admin`                          | none (UI)     | Admin web app (login inside)                           |
| `*`    | `/admin/api/*`                    | `ADMIN_TOKEN` | Admin data API (projects, allowlist, DM allowlist, messages, groups, readable-chats, inbound) |
| GET    | `/admin/openapi.json`             | `ADMIN_TOKEN` | Admin API OpenAPI 3.1 spec (no public Redoc)           |
| GET    | `/read/inbound`                   | `READER_TOKEN`| Inbound messages from `READER_CHATS` only — see [Read-only reader token](#read-only-reader-token) |
| GET    | `/read/inbound/:id/media`         | `READER_TOKEN`| Media for a message in `READER_CHATS`; 404 otherwise   |

### Status codes for POST /v1/post

| Code | Meaning                                                                       |
|------|-------------------------------------------------------------------------------|
| 200  | Sent (with or without transcode).                                             |
| 400  | Validation failed (zod schema).                                               |
| 401  | Missing or invalid project bearer token.                                      |
| 403  | `groupJid` not in this project's access × global allowlist intersection.      |
| 502  | WhatsApp send error, ffmpeg transcode failure, or media fetch failure.        |
| 503  | Bot not paired with WhatsApp.                                                 |
| 504  | Transcode did not finish within 120 s (very long source).                     |

### API documentation

The two API surfaces emit OpenAPI 3.1 specs directly from the zod schemas that validate incoming requests — so the docs cannot drift from behaviour by construction.

- **Project API** (public): browse `https://your-domain.example/docs`. Backed by `/openapi.json`.
- **Admin API** (private): preview locally with the spec pulled behind the admin bearer:

  ```bash
  curl -H "Authorization: Bearer $ADMIN_TOKEN" \
       http://localhost:8080/admin/openapi.json > /tmp/admin-spec.json
  npx @redocly/cli preview-docs /tmp/admin-spec.json
  ```

## Large-video transcoding

WhatsApp drops inline-video deliveries above ~16 MB on non-business
accounts. POST /v1/post HEADs the source `mediaUrl`; if it's over
the cap, the bot runs the source through `ffmpeg` (built into the
Docker image) to shrink it under the limit, then sends the
transcoded buffer.

Encoder settings (in `src/transcode.js`):
- Scale: ≤720p, preserving aspect ratio
- Video: H.264 high profile, ultrafast preset, dynamic bitrate sized
  to fit a 15 MB output target (computed from source duration)
- Audio: AAC 96 kbps, 2 channels
- Container: MP4 with `+faststart`

Status codes the caller may see:
- `200` — transcode + send succeeded
- `502 transcode failed` — ffmpeg/ffprobe error, or output still >16 MB
- `504 transcode timed out` — exceeded the 120 s deadline (very long source)

If the source host doesn't return `content-length` on HEAD, the bot
can't size-check pre-flight and falls through to the regular send
path; oversized videos in that case will be silently dropped by
WhatsApp (the original problem this guards against).

## Re-pairing

If the linked device drops or you rotate the WhatsApp account:

```bash
fly ssh console -C "rm -rf /data/auth-state"
fly machine restart
fly logs                    # wait for new QR
# /qr needs the admin token; save the PNG and open it (never put the token in a browser URL):
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" https://your-app-name.fly.dev/qr -o qr.png && open qr.png
```

`/data/wp.db` is untouched, so projects + tokens + allowlist survive.

## Local development

```bash
npm install

ADMIN_TOKEN=devadmin \
AUTH_DIR=./auth-state \
DB_PATH=./wp.db \
npm start

curl -fsS -H "Authorization: Bearer devadmin" http://localhost:8080/qr -o qr.png && open qr.png  # scan once
open http://localhost:8080/admin # paste "devadmin"

# Send a test message (after creating a project + allowlisting a group via UI)
curl -X POST -H "Authorization: Bearer <project-token>" \
  -H "Content-Type: application/json" \
  -d '{"groupJid":"<jid>","title":"Local test","permalink":"https://example.com"}' \
  http://localhost:8080/v1/post
```

`auth-state/`, `wp.db*`, and `node_modules/` are all gitignored.

## Operations cheatsheet

| Want to…                          | Command                                                          |
|-----------------------------------|------------------------------------------------------------------|
| See health                        | `curl https://your-domain.example/`                                     |
| Manage anything                   | `https://your-domain.example/admin`                                     |
| Tail logs                         | `fly logs`                                                       |
| Stop the bot (volume keeps billing) | `fly scale count 0`                                            |
| Restart                           | `fly scale count 1`                                              |
| Backup state                      | `fly ssh sftp shell <<< "get /data/wp.db ./wp.db.backup"`        |
| Fully decommission                | `fly apps destroy your-app-name && fly volumes destroy wa_data` |

## Further docs

- [`CONTEXT.md`](CONTEXT.md) — domain glossary: the core terms (Project, Group,
  Allowlist, Auth State, …) and how they relate.
- [`docs/adr/`](docs/adr/) — architecture decision records for the major design
  choices (API split, in-process transcode, group/community/DM support).

## License

[MIT](LICENSE) © 2026 knightkill — this project's own code is MIT-licensed.

A note on dependencies:

- **libsignal** (a transitive dependency of Baileys) is **GPL-3.0**. Publishing
  this repository's source under MIT is fine — MIT is GPL-compatible and the repo
  does not vendor libsignal — but redistributing a built artifact that bundles
  `node_modules` (e.g. a public Docker image) makes the combined work carry
  GPL-3.0 source-availability obligations. The lockfile may resolve libsignal over
  `git+ssh`; anonymous clones can fall back with
  `git config --global url."https://github.com/".insteadOf ssh://git@github.com/`.
- **ffmpeg / libx264** (GPL) are invoked as a **separate process** via `spawn`
  (see `src/transcode.js`), not linked, so this repo's MIT license is unaffected.
  Images that bundle ffmpeg binaries carry the usual GPL obligations on
  redistribution.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This repo follows the
[HARP v1.0.1](https://github.com/knightkill/harp/blob/v1.0.1/HARP.md) coding
standard.
