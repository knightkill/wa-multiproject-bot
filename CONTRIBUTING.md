# Contributing

Thanks for your interest. This is a small, single-maintainer project; issues and
pull requests are welcome but may be reviewed on a best-effort basis.

## Coding standard

This repo follows **HARP v1.0.1** — a short, citable coding standard for code that
reads well to both human reviewers and AI assistants:

> https://github.com/knightkill/harp/blob/v1.0.1/HARP.md

Please read it before opening a PR, and reference rule IDs in review (e.g. "this
fails HARP-2.1"). The high-value rules here:

- **Comments explain WHY, not WHAT** (HARP-2.1 / 2.2). Default to no comment; if a
  comment would restate the code, rename instead. Keep comments that carry a
  constraint, workaround, invariant, or reason the code can't express.
- **Descriptive names** (HARP §1). Booleans get an `is`/`has`/`can` prefix;
  functions read as verbs; no `data`/`tmp`/`obj`. Single-letter names only for the
  blessed cases (`c` = Hono context, `e` = caught error, `i`/`j`/`k` = loop index).
- **Small, single-purpose functions and one concept per file** (HARP §3, §4).

HARP's mechanical lint config targets a TypeScript/Vue stack; this repo is plain
ESM JavaScript, so the rules are applied at the review level rather than via lint.

## Development

```bash
npm install
ADMIN_TOKEN=devtoken AUTH_DIR=./auth-state DB_PATH=./wp.db npm start
```

The app reads its configuration from the process environment directly (there is no
`.env` auto-loading). See `.env.example` for the full list of variables.

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).
