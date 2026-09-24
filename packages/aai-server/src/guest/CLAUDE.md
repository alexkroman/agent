---
summary: >-
  The platform's view of a guest: the one platform→guest forward and its header
  policy, route exposure, the bearer gate, and exec-env/boot wiring.
read_when: >-
  editing anything in `aai-server/src/guest/` — `forward.ts`, `routes.ts`,
  `bearer.ts`, `exec-env.ts`, readiness or image-source.
---

# packages/aai-server/src/guest — the platform's view of a guest

What a guest may do and hold is in `packages/aai-guest/CLAUDE.md`
("Credential separation, and what reaches a guest", "Guest network access").

## `routes.ts` — every guest route declares its platform exposure

Adding or changing a guest route: use the `expose-guest-route` skill
(`.claude/skills/expose-guest-route/SKILL.md`). `routes.test.ts` checks the
platform half; `guard-invariants` rule 12 and konsistent's
`guest-route-exposure` check the rest.

## `forward.ts` — the one platform→guest forward

`forwardToGuest` and its header policy serve every route that proxies into a
tenant sandbox (`/client-config`, `/:slug/workflows/*`, the durable-run
webhook). Do not re-derive a forward in a handler.

- **A header crossing this hop reaches TENANT CODE**: `Cookie`,
  `Authorization` and `X-Forwarded-*` never do.
- **Every direction is an allow-list except the webhook's REQUEST** — a
  sender's signature headers cannot be enumerated; the webhook RESPONSE is
  still allow-listed. The doc argues the asymmetry.
- **A route forwarding a STREAMING request body needs `bound: "activity"`.**
  The other bounds (`"headers"`, `"response"`) cover the response head, so a
  guest that answers only after consuming the body has the whole upload inside
  its deadline. `aai dev` has no forward and will not show this. See the
  `bound` doc.

## `bearer.ts` — the guest bearer gate

- **A deleted agent is 404, never 503 and never 410.** A delete leaves no
  tombstone (every workflow table cascades off the agents row, rows are written
  `on conflict (slug) do update`, so `null` only means gone): 503 invites a
  retry that can never succeed, and 410 claims a history the platform cannot
  support. Existence is already disclosed elsewhere, so the 503 hid nothing.
  Same answer as `brokerSessionUrlOrThrow`, `workflow-handler.ts` and
  `upload-handler.ts`'s `assertAgentExists`. The module doc has the full
  argument, including which refusal wins.

## Directory scans must be rooted at `src/` and recursive

`exec-env.test.ts` reads every module in the package to find a second `TMPDIR`
setter; its 120-file floor fails the test if the scan silently narrows (e.g.
to this directory). Any spec that scans source must do the same.
