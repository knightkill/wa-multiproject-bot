# Split API surface into two OpenAPIHono sub-apps and adopt @hono/zod-openapi

The bot exposes two API surfaces with different audiences, stability promises,
and threat models: a public Project API (one route: POST /v1/post, used by
the operator's own projects) and a private Admin API (~10 routes, used only by the
bundled admin UI). We split the existing single Hono app into two
OpenAPIHono sub-apps — projectApp mounted at /, adminApp mounted at /admin —
so each emits its own OpenAPI spec at /openapi.json. The project spec is
rendered publicly via Redoc at /docs on Fly; the admin spec is previewed
locally only. The /v1 prefix is applied to the project surface to permit
future breaking changes without coordinating with integrators; the admin
surface stays unversioned because the UI is shipped in-process and changes
atomically with it. Adopting @hono/zod-openapi (replacing the existing
hand-rolled `typeof` checks in routes.js) ensures the spec is generated from
the same zod schemas that validate inbound requests — eliminating drift
between docs and behaviour by construction.
