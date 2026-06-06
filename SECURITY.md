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
- **Project tokens** are bearer credentials scoped to one project's allowed
  groups. They are stored only as SHA-256 hashes; rotate them from the admin UI
  if one leaks.

If you run this, treat the paired number as disposable: WhatsApp may restrict or
ban numbers used with unofficial clients (see the Disclaimer in the README).
