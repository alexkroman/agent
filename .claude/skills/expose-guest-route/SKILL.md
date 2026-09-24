---
name: expose-guest-route
description: >-
  Use when adding, renaming, or changing the methods of an HTTP route the agent
  guest serves (anything in aai-runtime's server/telephony/workflow/session
  routes or aai-guest's dispatch), or when deciding how the platform
  (aai-server) exposes a guest route — proxied, direct-dial, host-only or
  guest-internal. Covers GUEST_ROUTES / GUEST_ROUTE_EXPOSURE, the
  guest/routes.test.ts parity test, guard-invariants rule 12 and the
  guest-route-exposure konsistent convention.
---

# Expose a guest route on the platform

`aai dev` serves the guest's own routes directly, so a route that works in dev
can 404 on every deployed agent: deployed, only direct-dial callers reach the
sandbox, and everyone else needs a `/:slug/…` platform route. Both tables live
in `packages/aai-server/src/guest/routes.ts`.

## Procedure

1. **Add the route to `GUEST_ROUTES`** (hand-transcribed — `aai-server` may not
   import guest source, so it cannot be derived).
2. **Give it an exposure in `GUEST_ROUTE_EXPOSURE`.** A missing key is a compile
   error (`satisfies Record<keyof typeof GUEST_ROUTES, …>`). Pick by **who calls
   it**, not what it does:

   | Kind | Caller | Platform owes |
   | --- | --- | --- |
   | `proxied` | brokered clients (a page, a third party, a CLI) | a `/:slug<path>` route per method, forwarding via `guest/forward.ts` |
   | `direct-dial` | a client handed the sandbox URL (browser voice session, carrier after TwiML, studio chat) | nothing |
   | `host-only` | the platform itself, through the sandbox URL, bearer-gated | nothing public |
   | `guest-internal` | the guest's own machinery on loopback only | nothing — never write `host-only` here; that describes a token gate that is not there |

   For `proxied`: list the methods the **guest** answers, read from its
   dispatch (`if (url === X)` chains — there is no table to derive verbs from).
   Add `suffix` when the platform path ends in a parameter the guest parses
   itself (e.g. the webhook token).
3. **Make the platform match.** Register each proxied method under `/:slug` in
   the orchestrator. A route forwarding a streaming request body needs
   `bound: "activity"` (see `forwardToGuest`'s `bound` doc).
4. **Run the checks:**
   - `pnpm vitest run packages/aai-server/src/guest/routes.test.ts` —
     introspects the real orchestrator app: every declared proxied method must
     be registered, and a registered route must not be declared otherwise
     (catches a stale `direct-dial`).
   - `pnpm check:invariants` — **rule 12** scans the guest's HTTP
     surface as text (`aai-guest` plus the `aai-runtime` modules in
     `RUNTIME_ROUTE_SOURCES`) and fails on a route literal missing from
     `GUEST_ROUTES`.
   - `pnpm check:konsistent` — the **`guest-route-exposure`** convention pins
     the names `GUEST_ROUTES`, `GUEST_ROUTE_EXPOSURE`, `GuestRoute`,
     `GuestRouteExposure`; renaming one silently empties both gates above.

## What is and is not verified

- Platform half (declared vs registered): the test.
- Guest half (the route exists in `GUEST_ROUTES`): rule 12.
- Wrong METHODS on a declared route: nothing — declare them from the dispatch.

## Worked example: the three DevKit workflow routes

- `flow` and `step` are `guest-internal`: the guest's own worker dials them on
  loopback and they are unauthenticated because loopback is the gate. A
  platform route would let anyone replay another tenant's run. If the queue
  ever leaves the guest they need a route **and** an authenticity check.
- `webhook` is `proxied` (POST, with a token `suffix`): its URL goes to a third
  party and must outlive the sandbox that minted it.
