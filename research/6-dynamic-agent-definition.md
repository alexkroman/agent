---
issue: TODO
status: proposed
last_updated: "2026-08-14"
---

# Resolve the agent definition per session, and retire host mode's parallel path

Host mode exists because an agent definition can arrive at handshake time and
nothing in the ordinary session path can accept one that late. The answer was a
second session path — `?host=1`, `startHostSession`, `createHostServer` — running
beside the normal one. eve's `defineDynamic` is the general form of the same
capability, and it rides the event vocabulary
`3-session-event-stream.md` introduces.

**Depends on `3-session-event-stream.md`** for the resolver events
(`session.started` / `turn.started` / `step.started`).

## The finding is the parallel PATH, not the overlay

Worth stating precisely, because the obvious framing overstates the win. Host
mode is ~808 lines across five modules, and only a small part of it is
"definition supply":

| piece | lines | what it is | does a resolver replace it? |
| --- | --- | --- | --- |
| `buildHostAgent` | 12 | overlay `systemPrompt`/`greeting`/`maxSteps`/`sttPrompt` onto a base agent, empty `tools` | **yes** — this is the resolver body |
| `startHostSession` + `isHostAllowed` (`host-mode.ts`) | ~435 | the second session entry and its gate | **yes, indirectly** — see below |
| `host-server.ts` | 115 | a server variant whose only job is to be host-only | **yes** — becomes an agent definition |
| `host-relay.ts` | 136 | relayed tools: schemas in, execution back on the client | **no** |
| `host-env.ts` + `env-types.ts` | 110 | credential allowlist, per-connection merge, branded env records | **no** |

So `buildHostAgent` itself is twelve lines and replacing it buys nothing. What
costs is that those twelve lines can only be reached through a *parallel path*,
because the ordinary path has no seam for a definition that is not known at
build time. Give `agent()` a resolver and:

- `?host=1` becomes an ordinary session whose agent declares a resolver.
- `startHostSession` collapses into `ws-handler`'s normal path.
- `createHostServer` stops being a server variant and becomes an agent
  definition — which is what its own doc comment implies when it says the
  placeholder `agent()` it required "was never needed."
- `buildHostAgent` becomes an authored resolver body rather than framework code.

The relay and the credential machinery stay exactly as they are. They are
orthogonal to when the definition is decided.

## Prior art: eve's `defineDynamic`

`model`, `tools`, `skills`, `instructions` and `subagents` each accept
`defineDynamic({ events })` instead of a static value
(`docs/guides/dynamic-capabilities.md`). Resolvers run on `session.started`,
`turn.started`, or `step.started`, and the contract is spelled out in a way worth
copying wholesale:

- **Precedence is step > turn > session**, and the guidance is to prefer
  `session.started` because "prompt caches are per model, so switching
  mid-session re-ingests the conversation at uncached prices." AAI has the same
  hazard and no vocabulary for it.
- **Failures stop the turn.** "A resolver that throws, returns no model, or
  [selects a] model without valid credentials fails at request time." Explicit,
  rather than a definition silently falling back to the static one — which is
  the dropped-field failure family AAI's config guide is largely about.
- **Session/turn selections must be serializable** (model id strings), because
  they cross a durable step boundary. AAI's equivalent constraint is that a
  resolved definition has to survive the resume grace window.
- **Dynamic capabilities may return `null`** to omit themselves, so "this caller
  gets no such tool" is expressible without a sentinel.

The example that shows why the seam is worth having: routing image inputs to a
vision model on `step.started` by inspecting `ctx.messages`. Nothing in AAI can
express a per-turn model choice at all.

## What this is worth beyond deleting a path

Host mode is the ONLY way to vary an agent per caller today, and it is
client-supplied — so an operator who wants per-tenant instructions on their own
terms has no mechanism. That is a real gap that shows up in the guides sideways:
`sttPrompt` exists precisely because "the client owns the task's vocabulary —
spelled-out order IDs, product codes, passport numbers", which is a per-session
concern solved by adding a protocol field. A resolver is the general answer, and
the next such field does not need one.

## The risk, and it is the whole design question

**A resolver that reads handshake data inherits host mode's threat model.**
Host mode needs `AAI_ALLOW_HOST` and an allowlist *because* the definition comes
from an untrusted client: an unbounded credentials record would let a caller set
`DATABASE_URL` and open `ctx.db` against a Postgres they control, or set
`AAI_ALLOW_HOST` and self-approve. Those gates are load-bearing and documented as
such.

So the resolver contract has to keep two things apart that host mode currently
fuses:

- **Where the resolver's INPUT comes from.** An operator-authored resolver
  reading its own tenant table is a different security proposition from one
  reading a client-supplied handshake block. If both are "a resolver", the
  distinction has to be in the input type — the handshake block stays a
  distinctly-typed, validated, allowlisted value, and is not just another field
  on a context object.
- **What a resolver may DECIDE.** Returning a `systemPrompt` is harmless.
  Returning provider credentials, or anything that reaches `ctx.env`, is the
  escalation the branded env types (`sdk/env-types.ts`) exist to make
  non-silent. A resolver must not be a new route into `AgentEnv`.

Getting that wrong turns a documented, gated, opt-in surface into an ungated
general one — which would be strictly worse than the parallel path this plan
exists to delete. **If the boundary cannot be kept, do not do this**: host mode's
duplication is a price worth paying for a threat model that is written down.

### A resolved `greeting` breaks a memoization on the platform

The narrowest field list above contains a field the PLATFORM caches.
`aai-server/client-config-handler.ts` proxies `name`, `greeting` and `page` from
the guest's own `/client-config` and memoizes the answer **per guest origin** for
ten minutes, on the stated premise that "answers are immutable for a sandbox's
lifetime". A per-session resolver for `greeting` makes that premise false: the
first caller's resolved greeting would be served to every later caller of the same
sandbox, and the failure is silent and looks like caching working.

Three ways out, and only one keeps both properties:

- **Keep `greeting` static.** Cheapest, and it costs the plan the field most
  likely to be wanted.
- **Drop the memo.** A sandbox round trip on every page load, on a path with a
  1500 ms budget and a degrade-to-`{ sessionUrl }` on timeout — i.e. paying
  latency on the page-load path for a field the shell renders once.
- **Resolve only behind the session handshake**, so the pre-connection shell
  never sees a resolved value. This is the one to take, and it has a consequence
  worth writing into the resolver contract: **a resolver may not decide anything
  `/client-config` answers with.** That is a real constraint, not a formality —
  `page` decides whether the default client renders a start button at all.

### The platform half of host mode is ALREADY deleted

So every deletion in the scope table is `aai dev`'s, and the ~808 lines are not
platform lines. `aai-server/CLAUDE.md`'s "No host mode on deployed agents" records
why the platform version went — it was "the one path where the SERVER'S current
SDK interpreted a STORED config", a cross-version seam — and it names the one
condition under which it may return: "if platform host mode ever returns, run it
in the guest on the bundle's runtime."

A resolver is exactly that, so this plan makes that standing note ACTIONABLE
rather than obsolete: per-caller instructions on a deployed agent become
expressible with no in-process session surface and no host-side config
interpretation. It does not make it free. The input would arrive over a
platform-brokered handshake, which is the untrusted side of the boundary the
section above is about, and the platform today has no owner-auth on
`/:slug/websocket` at all — that upgrade is a pure redirect with no auth posture.
Adding one back is a platform change this plan does not scope and must not imply.

## Design sketch

`agent()` fields that may take a resolver, narrowest set first:
`systemPrompt`, `greeting`, `llm`, `sttPrompt`, `tools`. Deliberately NOT the
provider triple's credentials, and not `s2s` (mode selection is structural — the
type union in `sdk/define.ts` is what makes `PipelineOnlyMisuse` a compile error,
and a resolver would move that to runtime).

- **Resolver events reuse doc 3's vocabulary.** `session.started` is the one that
  matters here; `turn.started`/`step.started` are the extension point, not the
  first cut.
- **A resolver runs inside `session.start()`**, the same window
  `2-durable-session-state.md` uses for hydration — after `config` goes out at
  zero RTT, before the session is ready, with client audio buffered.
- **A resolver that throws fails the session** with the reason, via the existing
  `failClientAndClose` path. No fallback to the static value: that is the silent
  half-configured agent this repo keeps finding.
- **The handshake block stays its own validated type.** `HostConfigSchema` does
  not become "the resolver context"; it remains a distinct, allowlisted input a
  resolver may be handed.

## Scope

| Change | Where |
| --- | --- |
| Resolver type + `session.started` wiring inside `session.start()` | `sdk/define.ts`, `host/ws-handler.ts`, `host/runtime.ts` |
| Delete `startHostSession`, `isHostAllowed`, `buildHostAgent`, `createHostServer` | `host/host-mode.ts`, `host/host-server.ts` |
| Keep `host-relay.ts`, `host-env.ts`, `env-types.ts` unchanged | — |
| Re-express the host handshake as a resolver input | `sdk/protocol.ts` (`HostConfigSchema` retained, repurposed) |
| Update the one consumer that drives `?host=1` | see below |
| Keep resolved fields out of `/client-config`'s answer (see above) | `sdk/client-config.ts`, the resolver contract |
| Give back `host-mode.test.ts`'s two `as unknown as` entries | `scripts/escape-hatch-baseline.json` |
| Epoch bump for `aai:agent` as `--drop` | `contracts/` |

**The consumer to check first is the eval harness.** `?host=1` is how the
external voice harness connects, and `5-behaviour-eval-tier.md`'s level 1 is
planned to drive the same path. If both plans land, level 1 should drive the
resolver rather than the `?host=1` entry — so these two want sequencing against
each other, not just against doc 3.

## Open questions

- **Is `buildHostAgent`'s behaviour actually expressible as a resolver?** It
  overlays four fields and empties `tools`, which looks trivially expressible —
  but `tools: {}` is load-bearing (injected tools are RELAYED, not executed), so
  the resolver has to be able to say "these tool schemas, executed elsewhere."
  That is the relay boundary poking through, and it decides whether the tools
  field can take a resolver at all in the first cut.
- **Does `createHostServer` survive as a convenience?** Its value was doing three
  easily-forgotten things at once. If a resolver makes the host-only server an
  ordinary agent definition, the convenience might be better as a template than
  as an exported factory.
- **What does `AAI_ALLOW_HOST` become?** If the handshake input only reaches an
  agent that declares a resolver for it, declaring the resolver IS the opt-in and
  the env flag is redundant. That is the good outcome, and it needs confirming
  rather than assuming — the flag currently also gates a server that holds
  operator credentials.
