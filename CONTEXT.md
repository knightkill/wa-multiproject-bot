# wa-multiproject-bot

A single-tenant operator runs one paired WhatsApp account that forwards messages from several of their own software **Projects** into their respective WhatsApp **Groups**, over an HTTP API.

## Language

**Project**:
A tenant of the bot — has a name, one bearer **Project Token**, and a permitted set of **Group JIDs**.
_Avoid_: app, tenant, client, integration. Disambiguate from "engineering project" when context is unclear by saying **Project (tenant)**.

**Project Token**:
The bearer credential a Project presents at `POST /v1/post`. Stored only as a hash; the plaintext is shown once at issue / rotation.
_Avoid_: api key, secret, project key.

**Admin Token**:
The single operator credential that gates `/admin/*`. Sourced from the `ADMIN_TOKEN` environment variable. Not a Project Token; never resolves to a Project.
_Avoid_: master key, root token.

**Group**:
A WhatsApp group chat the paired account is a member of.
_Avoid_: chat, room, conversation.

**Group JID**:
The opaque identifier WhatsApp uses for a Group (e.g. `1234567890-1612345678@g.us`). The unit of access control.
_Avoid_: group id, chat id.

**Allowlist** (global):
The set of Group JIDs the bot is permitted to send to at all. Managed by the operator via the admin UI. A Group not in the Allowlist can never receive messages, regardless of any Project's configuration.
_Avoid_: whitelist, permitted groups.

**Project Group Access**:
The per-Project subset of the Allowlist that a given Project is permitted to target. A send is permitted only when the target Group JID is in **both** the Allowlist and that Project's Group Access.
_Avoid_: project groups, scopes.

**Pairing**:
The act of linking the bot to the operator's WhatsApp account via the QR code at `/qr` (WhatsApp → Settings → Linked Devices). One-time per **Auth State**; survives restarts.
_Avoid_: login, connect, sign-in.

**Auth State**:
The Baileys session credentials on disk (`/data/auth-state/`). Distinct from Project Tokens and Admin Token. Loss of Auth State requires re-Pairing the phone.
_Avoid_: session, credentials (ambiguous), keys.

**Post**:
One `POST /v1/post` call — a Project's unit of intent, carrying a title, an optional caption, an optional permalink, and zero or more Media items.
_Avoid_: message, send, request, payload.

**Album**:
An ordered sequence of one or more Media item bubbles sent in rapid succession (back-to-back, same sender) to a Group, with no captions on any item. Modern WhatsApp recipient clients cluster these into a single visual stack ("album-like" rendering); older clients show them as distinct bubbles in a row. Not a WhatsApp protocol primitive — there is no first-class `albumMessage` send path in the installed Baileys version, so an Album is a *send-time pattern*, not a single wire message.
_Avoid_: carousel, gallery, slideshow, attachment block.

**Media item**:
A single image or video belonging to an Album, identified by a URL and a MIME type. May be `image/*` or `video/*`; a single Album may mix the two.
_Avoid_: attachment, file, asset, media object.

**Text card**:
The text-only WhatsApp message bubble that precedes the Album (or stands alone, when a Post has no media), carrying the formatted title, optional caption, and optional permalink. Sent first so that, on partial failure, the group still has orientation.
_Avoid_: footer, summary, caption block.

**Message Log**:
A bounded record (5000 rows) of every send attempt — successful or failed — with project name, target Group JID, title, status, error. Used by the admin UI's "Messages" view.
_Avoid_: history, audit log.

**Participant**:
A phone-number JID (`<number>@s.whatsapp.net`) identifying a person who has been, or is being, added to a Group. Distinct from a Group JID (which ends `@g.us`). A `create_group` / participants-add call accepts raw phone numbers and normalizes them to Participant JIDs; WhatsApp may refuse an add (privacy settings, a block, a recent leave) — that is a per-Participant status, not a Group-level failure.
_Avoid_: member, user, contact, recipient.

**Invite link**:
The opt-in path into a Group: `https://chat.whatsapp.com/<code>`, where `<code>` is the current invite code returned by WhatsApp. Preferred over a force-add, because a Participant whose privacy settings block being added (status 403) can still join by following the link. Revoking the invite rotates the code and invalidates the old link.
_Avoid_: join link, share link, group url.

**Group setting**:
A toggle on a Group governing who may act. `announcement` = only admins may post (the rest of the Group is read-only); `not_announcement` reverses it. `locked` = only admins may edit the Group info (subject, description, icon); `unlocked` reverses it. Changing a Group setting is a Group-management action, not a Post.
_Avoid_: permission, mode, policy.

**Group lifecycle**:
The create-and-leave span of a Group's existence as seen by this bot. `create_group` makes a new Group (the paired account is its creator/admin) and binds it to the calling Project; `leave_group` exits a Group and detaches it from that Project. Lifecycle events are logged but never written to the Message Log (which is for Posts only).
_Avoid_: provision, teardown, manage.

**Community**:
A WhatsApp Community — a parent Group (JID `@g.us`, like any Group) that holds a set of linked Sub-groups. The paired account creates a Community via `create_community`; the bot must be a Community admin to link or unlink Sub-groups under it. A Community shares the Group JID shape and the same access-control unit as a Group, so it flows through the identical Allowlist + Project Group Access checks — there is no separate community permission model.
_Avoid_: org, space, channel, server, group-of-groups.

**Sub-group / linked Group**:
A Group linked under a Community (WhatsApp `link_type` `sub_group`). A Sub-group is an ordinary Group in every other respect — own subject, own Participants, own Group settings, own invite — that additionally answers to a parent Community. Created either standalone and then linked, or directly under a parent via `create-group-under-parent`. Unlinking detaches it from the Community without deleting the Group.
_Avoid_: child group, nested group, sub-community.

**Direct message / DM**:
A 1:1 message sent to a single Participant via `sendMessage` (`POST /v1/dm`), as opposed to a Post to a Group. The opt-in, low-volume exception to the default distribution path — the recommended channel remains an invite-link Group Post. DM is high ban-risk and is the reason every WA-3 safeguard exists. A DM carries only a recipient JID and text; it is not a Post and never writes to the Message Log.
_Avoid_: pm, private message, 1-1, dm blast.

**DM allowlist**:
The opt-in set of user JIDs the bot is permitted to DM at all (`dm_allowed` table). The `403` gate on `POST /v1/dm`: a recipient not in the DM allowlist can never be DMed. Operator-managed via `/admin/api/dm-allowlist`. Distinct from the group **Allowlist** — that gates which Group JIDs may receive Posts; this gates which Participant JIDs may receive DMs. The two never share rows.
_Avoid_: dm whitelist, contacts, recipients list, permitted numbers.

**Send throttle**:
The server-enforced pace on DM delivery: a per-message jitter delay (`DM_JITTER_MIN_MS`/`DM_JITTER_MAX_MS`) plus a per-minute cap (`DM_CAP_PER_MIN`) and a per-day cap (`DM_CAP_PER_DAY`). Sourced only from the process environment; **never settable or overridable from the request body or query**. A caller can express intent but cannot speed up or raise limits.
_Avoid_: rate limit, debounce, backoff, delay setting.

**Restriction auto-pause**:
The queue stopping itself the moment WhatsApp signals a restriction (error matching the restriction pattern, or status 401/403/423/429). On trip, the singleton pause state (`dm_state`) is set, `POST /v1/dm` returns `423`, and the offending DM is left pending so it resumes intact after un-pause. There is no auto-resume; coming back is an admin/operator action via `POST /admin/api/dm/resume`.
_Avoid_: circuit breaker, cooldown, throttle (use Send throttle for the pace), block.

**DM queue**:
The resumable, idempotent SQLite table (`dm_queue`) that holds DMs awaiting delivery. A background loop drains it one at a time under the Send throttle; `POST /v1/dm/batch` enqueues and returns without sending synchronously. Each row's `idempotency_key` (`batchId:toJid`) is UNIQUE, so a retry, double-submit, or restart mid-drain never double-sends. Pending rows survive a restart and are picked up on boot.
_Avoid_: outbox, buffer, spool, job list.

## Relationships

- A **Project** has one **Project Token** and many entries in **Project Group Access**
- A **Project Group Access** entry references one **Group JID** that must also exist in the **Allowlist**
- A send via `POST /v1/post` is authorized ⟺ the **Project Token** resolves to a **Project** AND the target **Group JID** ∈ (**Project Group Access** ∩ **Allowlist**)
- A **Post** produces one **Text card** followed by one **Album** when it has media, or only a **Text card** when it has none
- An **Album** contains one or more ordered **Media items**; mixed `image/*` and `video/*` permitted
- Each accepted **Post** writes one row to the **Message Log**, regardless of how many WhatsApp bubbles it produces
- The **Admin Token** is unrelated to any **Project** — it controls the **Allowlist** and Project lifecycle, not sends
- `create_group` appends the new **Group JID** to **both** the **Allowlist** and the creating **Project**'s **Project Group Access**, so that Project can immediately Post to and manage it; this append is the only way besides the admin UI to add to the Allowlist, and it never removes an entry
- `leave_group` removes the **Group JID** from that **Project**'s **Project Group Access** but leaves the **Allowlist** untouched — pruning the Allowlist stays an operator decision via the admin UI
- A **Community** is a **Group** whose JID also ends `@g.us`, so it is governed by the **same** Allowlist + Project Group Access intersection as any Group — community endpoints carry no separate permission model
- `create_community` and `create-group-under-parent` follow the same **append-only** grant as `create_group`: the new **Group JID** (the Community, or the new Sub-group) is appended to **both** the **Allowlist** and the creating **Project**'s **Project Group Access**, and nothing is ever removed
- Linking or unlinking requires **both** the parent **Community** JID **and** the **Sub-group** JID to be permitted (each in Project Group Access ∩ Allowlist); a request naming a JID the Project may not target is rejected 403, identifying which one
- Community linking exists only because the bot now runs **Baileys 7.0** — the `communityCreateGroup` / `communityLinkGroup` / `communityUnlinkGroup` / `communityFetchLinkedGroups` methods are not present in the 6.x line the rest of the bot was built on
- A **DM** to a Participant is authorized ⟺ the **Project Token** resolves to a Project AND the recipient JID ∈ the **DM allowlist**; this is a separate gate from the Posts intersection (Project Group Access ∩ group Allowlist) and shares nothing with it
- Every accepted **DM** becomes a row in the **DM queue**, drained one at a time under the **Send throttle**; the throttle's jitter and caps come only from the environment, so no **Project** can DM faster than the operator-configured pace, regardless of how the request is shaped
- A **DM** never writes to the **Message Log** — that table records Posts; DM delivery state lives in the DM queue (`pending`/`sent`/`failed`/`skipped`) and is read back via `GET /v1/dm/status`
- A WhatsApp restriction on a **DM** triggers **Restriction auto-pause**: the **DM queue** halts and the in-flight row stays `pending`, so on operator un-pause it resumes without double-sending (the `idempotency_key` enforces this)
- The default distribution path remains an invite-link Group **Post**; **DM** is the opt-in, low-volume exception — high ban-risk, and the reason the **Send throttle**, **Restriction auto-pause**, and **DM allowlist** all exist

## Example dialogue

> **Dev:** "When a Project's token is rotated, what happens to its Group Access?"
> **Operator:** "Nothing — the Project's identity is its row in `projects`, not its token. Rotation replaces the token_hash; the Project Group Access rows are keyed by project_id and stay intact."

> **Dev:** "If I remove a Group from the Allowlist, do I have to also remove it from every Project's access?"
> **Operator:** "No. Authorization is the intersection at send time. Removing it from the Allowlist immediately blocks all sends to it; the per-Project rows become dormant but harmless."

## Flagged ambiguities

- "project" — overloaded between **Project (tenant)** and "engineering project" (e.g. "this Node project"). Resolution: capitalised **Project** always means the tenant in this codebase.
- "token" — used for **Project Token**, **Admin Token**, and Baileys auth tokens inside **Auth State**. Resolution: always qualify (Project Token / Admin Token); never bare "token" in docs.
- "groups" — used for both Groups the paired account is *in* (live, from Baileys) and Groups *in the Allowlist*. Resolution: the admin UI distinguishes them as "live groups" vs "allowed groups".
