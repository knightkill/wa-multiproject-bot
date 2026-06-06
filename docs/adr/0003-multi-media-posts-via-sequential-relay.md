# Multi-media Posts via pre-uploaded sequential relay

`POST /v1/post` now accepts `media: [{ url, type }, ...]` (mixed `image/*`
and `video/*`, up to 10 items) replacing the singleton `mediaUrl` /
`mediaType`. The recipient sees one Text card followed by a sequence of
Media item bubbles sent in rapid succession. Modern WhatsApp clients
cluster these into a visual stack; older clients show them as distinct
bubbles in a row.

We considered using WhatsApp's protocol-level `albumMessage` to produce
a true single-bubble Album. Baileys 6.7.21 exposes the proto type but no
public send path — `AnyMediaMessageContent` accepts only one media per
call, and there is no `sendAlbumMessage`. Building it ourselves would
mean reverse-engineering the WAProto correlation field that links child
media to the album header, then hoping recipient clients render the
correlation correctly. Multi-day archaeology with breakage risk on every
Baileys/WhatsApp update — disproportionate for a personal bot.
Sequential relay gets ~90% of the visual outcome on modern clients for
free.

Inside the send pipeline we decompose `sock.sendMessage` into its two
phases. Each Media item goes through `generateWAMessage(jid, { image |
video: buf, ... })` first — which uploads the bytes to WhatsApp's media
servers and returns a prepared proto — with a concurrency cap of 2 to
bound RAM on the 256 MB box. The Text card is prepared the same way
(no upload, just proto generation). Only once all N+1 protos are ready
do we call `sock.relayMessage` for each, Text card first, then Media
items in array order. This collapses the slow / flaky phase (uploads)
to *before* any bubble is visible in the group, so a mid-Post failure
aborts cleanly with nothing visible to the recipient. The natural
~50–200 ms cadence of sequential `relayMessage` round-trips keeps Album
items well inside the empirical 1 s clustering window — no explicit
pacing.

Total Post wall time is bounded by a 270 s `AbortSignal` budget enforced
in the handler, with Fly's proxy `idle_timeout` bumped to 300 s in
`fly.toml` to match. The existing per-transcode 120 s deadline stays —
most Posts complete in 1–10 s; pathological all-video Posts will trip
the total budget and 504 before the proxy disconnects us. Posts that
consistently exceed 270 s are the trigger to revisit (streaming
heartbeats or an async 202+polling model).
