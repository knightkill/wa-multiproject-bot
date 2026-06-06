# Project-scope group management mirroring POST /v1/post

The bot now exposes nine group-lifecycle endpoints under `/v1/groups/*`
— create, add/remove participants, fetch/revoke invite, change setting,
update subject/description, leave — so a Project can stand up and run
its own WhatsApp Groups without the operator touching the admin UI. Every one
is Project-scope: Bearer Project Token via the same `requireProject`
middleware that gates `POST /v1/post`, body-based (`groupJid` in the
JSON body, never the path), and `503 { error: "not paired" }` when the
bot has no live WhatsApp session. Endpoints that target an existing
Group enforce the identical guard as the post route — the Group JID must
be in (Project Group Access ∩ Allowlist) or the call is
`403 { error: "groupJid not permitted for this project" }`, same wording
and shape. We deliberately kept permission parity with posting rather
than inventing a second authorization model: a Project that may send to
a Group may also manage it, and nothing more.

`create_group` is the one exception to the pre-existing-permission
check, because there is no Group to check against yet. After
`sock.groupCreate` returns the new JID, the handler performs two
server-side DB writes: it appends the JID to the global Allowlist
(`addAllowedGroup`) and to the calling Project's Group Access
(`addProjectGroup`), so the Project can immediately post to and manage
what it just made. This widens who can append to the Allowlist beyond
the admin UI — previously the operator's sole privilege. We accept that
because the grant is **append-only**: `create_group` never removes an
Allowlist entry, and the blast radius is bounded to exactly the Group
the caller just created (it cannot grant itself access to any
pre-existing Group). The symmetric destructive operation, `leave_group`,
deliberately does **not** mutate the global Allowlist — it leaves the
WhatsApp Group and removes the JID from that Project's Group Access
(returning whether a row was deleted), but the Allowlist row stays so
the operator decides whether to prune it via the admin UI. Removing it
automatically would let one Project silently revoke a Group another
Project still targets.

Participant adds return a per-JID status rather than a single
pass/fail, because WhatsApp frequently refuses an add for reasons that
are not failures of the call. Each element of the Baileys
`groupParticipantsUpdate` result is mapped to `{ jid, status, added }`
(with `added` true only on `"200"`), and the raw `content` node — a
binary proto — is dropped, never serialized. For adds, non-200 statuses
carry a human `note`: `403` means the Participant's privacy settings (or a
block) prevent a force-add, `408` means they recently left and can't be
re-added yet, `409` means they're already in. Crucially a 403/408 does
**not** fail the batch; the other participants still go in, and the
caller is steered to the **Invite link** (`groupInviteCode` is fetched
on create and exposed by `invite/code`) as the opt-in path. This
invite-link-first posture is also our main mitigation against the
Baileys ban risk that the whole project already accepts (see README
caveats): pushing people into Groups they didn't ask for is exactly the
behaviour WhatsApp flags, so we make the polite path the default and the
force-add the fallback, not the reverse.

Batches are capped at 20 participants per call (`create`, `add`, and
`remove`) via zod `.max(20)`; over-cap requests are rejected `400` by
the existing `zodErrorHook` before any WhatsApp round-trip. The cap is a
crude rate-limit against bulk-add patterns that draw bans, and keeps a
single call's failure surface small.

On the optional steps of `create_group` (adding the initial
participants, flipping announce, setting the description, fetching the
invite code) failures are collected into a `warnings[]` array rather
than failing the whole call — the Group exists and the Project owns it,
so we return `200` with whatever succeeded and let the caller retry the
parts that didn't. Only `groupCreate` itself failing maps to `502`.
After create, subject change, and leave we call `groupsCache.invalidate()`
so the live-groups view reflects reality. Group lifecycle events are
logged via `logger.info`; we do **not** write to the Message Log — that
table records Posts, not group administration.
