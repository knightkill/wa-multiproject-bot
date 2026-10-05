# Security Policy

## Reporting a vulnerability

Please report security issues **privately** rather than opening a public issue.
Use GitHub's private vulnerability reporting ("Report a vulnerability" under the
repository's **Security** tab). This is a single-maintainer project, so please
allow reasonable time for a fix before any public disclosure.

## Threat model

This service holds credentials worth protecting:

- **`auth-state/` is the WhatsApp account.** Possession of that directory grants
  full send/receive control of the paired number without re-pairing. It is
  gitignored and must never be committed, copied into a Docker image, or shared.
- **`ADMIN_TOKEN`** guards the entire admin API and the `/qr` pairing page —
  project/token/allowlist management and the ability to re-pair the bot. Use a
  high-entropy value (`openssl rand -hex 32`) and store it as a secret.
- **`READER_TOKEN`** (optional) can only `GET /read/inbound` and
  `GET /read/inbound/:id/media`, and only for chats listed in `READER_CHATS`.
  A leak exposes the captured messages and media of those chats — nothing else:
  it cannot send, change groups or allowlists, rotate tokens, or pair. It is
  refused if shorter than 32 chars or equal to `ADMIN_TOKEN`, and `ADMIN_TOKEN`
  is not accepted on `/read/*`. Fetching media the bot did not save on arrival
  makes the bot ask WhatsApp to re-upload it, so a reader can cause that one
  outbound protocol request. Revoke by unsetting or rotating the secret.
- **Project tokens** are bearer credentials scoped to one project's allowed
  groups. They are stored only as SHA-256 hashes; rotate them from the admin UI
  if one leaks.

If you run this, treat the paired number as disposable: WhatsApp may restrict or
ban numbers used with unofficial clients (see the Disclaimer in the README).
