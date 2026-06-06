# Community support requires Baileys 7.0

WA-2 adds seven Project-scope endpoints under `/v1/communities/*`
— create a Community, create a Sub-group directly under a parent, link
and unlink an existing Group, list participating Communities, and fetch
a Community's linked Sub-groups and metadata — so a Project can stand up
and run its own WhatsApp Community structure without the operator touching the
admin UI. To do this we had to upgrade Baileys from `6.7.21` to
`7.0.0-rc13`. The 6.x line the rest of the bot was built on exposes no
community surface at all; `7.0.0-rc13` is the only published version that
adds the socket methods this feature is built on — `communityCreate`,
`communityCreateGroup`, `communityLinkGroup`, `communityUnlinkGroup`,
`communityFetchLinkedGroups`, `communityFetchAllParticipating`,
`communityMetadata`, and `communityInviteCode`. There was no way to
implement WA-2 on the version WA-1 shipped.

The upgrade is otherwise invisible to the running bot. We verified the
Auth State creds format is identical between `6.7.21` and `7.0.0-rc13`,
so the existing paired session keeps working — no re-Pairing, no QR
re-scan, `/data/auth-state/` is untouched on upgrade. The group methods
WA-1 relies on (`groupInviteCode`, `groupSettingUpdate`,
`groupParticipantsUpdate`, `groupUpdateDescription`) are unchanged in
7.0, so the existing `/v1/groups/*` endpoints carry over without edits.

Community operations reuse the WA-1 permission model wholesale rather
than inventing a second one. A Community JID is a Group JID — it ends
`@g.us` and is the same access-control unit — so every community endpoint
runs the identical `requireProject` middleware and the same
(Project Group Access ∩ Allowlist) intersection that gates `POST /v1/post`
and `/v1/groups/*`. `create_community` and `create-group-under-parent`
mirror `create_group`'s append-only grant: there is no pre-existing JID
to check, so the handler creates first and then appends the new JID to
both the global Allowlist (`addAllowedGroup`) and the calling Project's
Group Access (`addProjectGroup`), bounded to exactly the Community or
Sub-group it just made and never removing anything. Linking and
unlinking demand that **both** the parent Community JID and the target
Group JID already be permitted, and a `403` naming the offending JID is
returned otherwise — you cannot link a Group you may not target into a
Community you may not target. The list endpoint (`GET /v1/communities`)
is read-only discovery and so carries no `403`: it returns every
participating Community and annotates each with a `permitted` boolean
rather than filtering or rejecting.

When `create-group-under-parent` seeds the new Sub-group with initial
members, we preserve the per-JID add status exactly as `create_group`
does: each element of the `groupParticipantsUpdate` result maps to
`{ jid, status, added, note? }`, a `403`/`408` does not fail the batch,
and the caller is steered to the Invite link as the opt-in path. The
sub-group is created with **no** participants first (so the JID exists
and is granted before any add can fail), then members are added,
`announce`/`description` are applied best-effort into `warnings[]`, and
the invite code is fetched best-effort — only `communityCreateGroup`
itself failing maps to `502`. After every lifecycle event we call
`groupsCache.invalidate()` so the live-groups view reflects the new
structure, and we log via `logger.info`; community operations never
write to the Message Log, which records Posts only.

Linking a Group under a Community requires the bot to be a Community
admin — that is a WhatsApp-side constraint, not ours; a link/unlink call
against a Community where the paired account lacks admin comes back as a
`502` with the WhatsApp error detail, the same way other sock failures
surface.

The cost of all this is pinning a release candidate. `7.0.0-rc13` is not
a stable release, and we are taking it for the community methods alone.
Revisit this pin when Baileys 7.0 ships stable: bump to it, re-verify the
Auth State creds format is still compatible, and re-run the community
flows before relying on them.
