# Contact names: WhatsApp address book first, Google second, stored side by side

Until WA-4 the bot knew people only as JIDs. The admin API, the MCP and the
operator all had to map `919099655122@s.whatsapp.net` (or worse, an opaque
`…@lid`) to a person by hand. Two sources of names exist:

1. **The operator's WhatsApp address book.** The phone syncs every saved
   contact's name to linked devices as `contactAction` mutations in the
   `critical_unblock_low` app-state collection. Baileys 7 already decodes
   them into `contacts.upsert` events (`{ id, name, lid, phoneNumber }`) and
   emits `lid-mapping.update` for the LID ↔ phone pair. The bot ignored both.
2. **The operator's Google Contacts** (≈2,100 entries in the personal Gmail
   account, with ~830 duplicate groups). They include people the phone does
   not have and spellings the phone does not use.

A third, weaker source rides on every message: the **pushName** the person
set on their own profile.

## Decision

- One `contacts` row per person, keyed by phone-number JID when known and by
  LID until a mapping arrives (`setLidMapping` then folds the LID row into
  the phone row). A separate `lid_map` table keeps LID → phone pairs from
  app-state, history sync and the `remoteJidAlt` / `participantAlt` fields
  on message keys.
- **Each source owns its own column** (`wa_name`, `google_name` +
  `google_aliases`, `push_name`). The shown name is chosen at read time:
  WhatsApp address book → Google → pushName. A Google snapshot can therefore
  never overwrite a WhatsApp name, and re-running either sync is idempotent.
- **WhatsApp names arrive by event**, with `POST /admin/api/contacts/resync`
  to backfill an already-paired session: it deletes the stored
  `critical_unblock_low` version and calls `resyncAppState(…, true)`. With no
  stored version Baileys fetches a full snapshot and treats every mutation as
  new, so each saved contact replays as `contacts.upsert`. No re-pairing.
- **Google names are pushed, not pulled.** An Apps Script in the Google
  account (`apps-script/contacts-push/`) runs hourly and `PUT`s a full
  snapshot to `/contacts/google`. The bot holds no Google credential; the
  script holds only `CONTACTS_PUSH_TOKEN`, which unlocks that one write.
  Running as an Apps Script avoids an OAuth client whose consent screen,
  left in "Testing", would expire refresh tokens every 7 days.
- Phones are normalised on the bot with `libphonenumber-js` (default region
  India; a bare international number missing its `+` is retried with one).
  Google duplicates sharing a number collapse to the most recently updated
  name; other spellings are kept as aliases and searched.
- **Names are admin-only.** `GET /admin/api/contacts` and the `sender_name` /
  `chat_name` fields on `/admin/api/inbound`. The reader tier and Project
  tokens see none of it, and contacts never feed the DM allowlist: resolving
  a name to a JID is an explicit lookup, never an implicit step inside a send.

## Rejected

- **Google People API pulled by the bot on Fly** — puts a Google refresh
  token on an internet-facing host for no gain over a push.
- **People API in the local MCP only** — names would exist only in Claude's
  view, not in the bot's own records or other consumers.
- **Name resolution inside `send_dm` / `add_participants`** — a fuzzy match
  that lands on the wrong person turns a typo into a DM on the high
  ban-risk path.
