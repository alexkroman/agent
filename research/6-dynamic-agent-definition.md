---
issue: TODO
status: abandoned
last_updated: "2026-08-15"
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

## Outcome: ABANDONED — the trusted half of the input is empty

Written up in full below, and not built. Four things were checked against the
tree before deciding, and each one takes a load-bearing premise away.

**1. There is no trusted per-caller input for a resolver to read, so one side of
this plan's own security boundary does not exist.** The plan's rule is that
"where the resolver's INPUT comes from" must stay visible in the type: an
operator-authored resolver reading its own tenant table is a different
proposition from one reading a client-supplied handshake block. Every session
entry point was checked, and NONE of them carries an authenticated caller
identity a tenant could be looked up BY:

| entry | per-connection input the host can trust |
| --- | --- |
| platform `/:slug/websocket` | none — a pure handshake redirect (`orchestrator-ws.ts`), no auth posture, and the owner-authenticated version was deliberately deleted |
| guest `/session` on the sandbox tunnel | none — dialled directly by the browser off the client-config broker |
| `aai dev` `/websocket` | none — loopback, single user |
| `WS /phone` | none surfaced — `telephony-bridge.ts` reads no carrier-asserted `From`, and hands the socket straight to `startSession` |

`parseWsUpgradeParams` carries `sessionId` and `resume` and nothing else, and a
fresh session id is a random UUID. So the only per-connection input that reaches
a resolver is the CLIENT-SUPPLIED handshake — the untrusted one. "A resolver"
and "host mode" would be the same feature with the same threat model, and the
general form would carry the gate's absence rather than the gate. That is this
plan's own stop condition, reached from the input side rather than the return
side: *if the boundary cannot be kept, do not do this.*

The gap this plan named as its win beyond deletion — "an operator who wants
per-tenant instructions on their own terms has no mechanism" — is therefore not
delivered by a resolver either. A resolver would have nothing to key on.

**2. Host mode is a PRELUDE to the ordinary path, not a parallel one, so the
seam this plan says is missing already exists.** `startHostSession` ends in
`runtime.startSession(ws, …)`. From there it is `wireSessionSocket` →
`createSession` → the same `SessionCore`, the same transports, the same tool
executor, with the relay attached through `RuntimeOptions.executeTool` /
`toolSchemas` / `onToolResult` — three options that were already the seam for "a
definition not known at build time". What looks like a second path is the
handshake PRELUDE, and no resolver can delete it, because "the definition
arrives at handshake time" is what generates it: the deferred start, the
handshake timeout, the socket-died-first race, the env promise, the
per-connection runtime teardown.

**3. The 808 lines re-measured: ~200 are deletable, not 808.** Split by whether
a resolver removes the code or renames it:

| piece | lines | verdict |
| --- | --- | --- |
| `isHostAllowed` (`host-mode.ts` 58-79) | 22 | deletable |
| `buildHostAgent` (`host-mode.ts` 126-161) | 36 | deletable — becomes author code |
| `host-server.ts` | 115 | deletable — becomes an agent definition |
| the `?host=1` branch in `server.ts` + `hostModeEnv` | ~28 | deletable |
| `startHostSession` + its options (`host-mode.ts` 163-201, 291-462) | 211 | INHERENT — renamed, not removed |
| `unknownCredentialName` / `withHostCredentials` (81-124) | 44 | keep (plan agrees) |
| `sendEvent` / `rejectHandshake` (203-232) | 30 | keep |
| `assertHostRatesSupported` / `s2sConfigFromHandshake` (234-289) | 56 | keep — measured, and pinned by `packages/aai/CLAUDE.md` |
| `host-relay.ts`, `providers/host-env.ts`, `sdk/env-types.ts` | 253 | keep (plan agrees) |

So the diff would be roughly line-NEUTRAL: ~200 lines out, a resolver type, its
wiring, its docs and ~650 lines of reworked tests in. The plan's table
attributed "~435 lines" to "the second session entry and its gate", which
conflates the gate (22) with the credential screen, the rate refusal and the
deferred-start machinery it also says to keep.

**4. The resolvable field set collapses to ONE field on this architecture.** The
unit that holds a definition is the RUNTIME, not the session: `agentConfig`,
`toolSchemas`, the provider resolution (`runtime-pipeline-providers.ts`, eager
and deliberately per-runtime), the transport factory and the system-prompt cache
are all fixed at `createRuntime`. `BuildTransportArgs` is
`{ sessionOpts, systemPrompt, callbacks }` — `systemPrompt` is the ONLY
definition field already passed per session. Of the five fields this plan
sketches: `greeting` is excluded by this plan's own `/client-config` rule,
`tools` is excluded because a relayed tool is a schema plus an execution CHANNEL
(see the answered questions below), `llm` would put a per-session vendor-SDK
resolution on the session-start path that is hoisted off it on purpose, and
`sttPrompt` reaches the transports through the per-runtime `agentConfig`. A
resolver that "runs inside `session.start()`" can therefore decide the system
prompt and nothing else — and a resolver that decides more has to build a
per-connection runtime, which is `startHostSession`.

### And the platform surface would be WIDER, not narrower

Worth recording, because it is the opposite of what the plan expects from
`aai-server/CLAUDE.md`'s standing note. Host mode is unreachable on a deployed
agent **by construction, not by a flag**: `createServer`'s host branch is
`wantsHost && env && isHostAllowed(env)`, and the guest harness calls
`createServer` with no `env` at all (`harness-agent-mode.ts`, `harness.ts` —
`env` goes to `createRuntime`, never to the server). So no tenant secret can
re-enable it either; the argument is simply absent.

A resolver's handshake cannot be gated that way, because delivery is what calls
the resolver. Either the capability is `aai dev`-only — in which case the
plan's headline benefit, making per-caller instructions expressible on a
deployed agent, is nil — or it opens a handshake surface in the guest that is
closed today, on an upgrade with no auth posture. The plan is right that adding
that auth back is out of scope; the consequence is that this plan is BLOCKED on
it rather than adjacent to it.

### What would revive this

Not the resolver type — the trusted input. Something that gives a connection an
authenticated identity the host can hand a resolver: the platform's owner-auth
on `/:slug/websocket` returning, or `createServer`'s `upgrade` hook growing a
return value richer than `boolean` so a self-hosted operator can attach the
identity it already authenticated. With that in place the plan's distinction #1
has two non-empty sides and can be enforced by a type. Without it, "resolver"
means "the client decides", which is what `?host=1` already says out loud.

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

**Not executed** — kept as the record of what was proposed, and because the
next proposal in this area will start from it. See "Outcome" above.

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

## Open questions, ANSWERED

Answered against the tree; these are what turned the plan down.

- **Is `buildHostAgent`'s behaviour actually expressible as a resolver? NO —
  not the `tools` half, and not in any cut.** A resolver returns DATA. A relayed
  tool is a schema plus an execution CHANNEL, and the channel is the client
  socket — so "these tool schemas, executed elsewhere" is not something the
  return value can say. It is said today by two runtime options beside the
  agent (`toolSchemas` + `executeTool`, with `onToolResult` closing the loop),
  and those cannot move onto an `AgentDef` field because `AgentDef` is
  serialized into the stored config while a relay is a live socket. The
  workaround — a resolver returning `relayedTools` that the framework wires to
  "the peer that supplied them" — is coherent, and it is also an admission that
  the field only means anything for a handshake-supplied definition, i.e. it is
  host mode's concept with a general name. So `tools` cannot take a resolver,
  which is what this question said would decide the first cut.

  The other four fields ARE expressible, and three of them are worth nothing
  without the fourth: `maxSteps` and `sttPrompt` are per-runtime today,
  `greeting` is barred by the `/client-config` rule this plan sets, and
  `systemPrompt` alone does not need a new authoring surface.

- **Does `createHostServer` survive as a convenience? It survives BETTER than
  the resolver does.** Its whole value is the three things it says once and
  correctly — no agent, no env gate to remember, no credentials required — and
  each of the three is a statement about a SERVER, not about an agent
  definition. A resolver could carry the definition overlay and would carry
  none of the rest: the declining runtime for plain `/websocket`, the `env: {}`
  default that makes an unauthenticated caller safe to serve because there is
  no operator credential to spend, and the typed `defaults` that excludes the
  four fields the handshake owns. It is 115 lines that a nine-line agent
  definition does not replace.

- **What does `AAI_ALLOW_HOST` become? It has to STAY, which is the clearest
  single reason not to do this.** "Declaring the resolver is the opt-in" is true
  of the AUTHOR and false of the OPERATOR, and on this platform they are
  different people: an operator runs a server holding provider credentials, and
  the flag is what stops a definition supplied by an unauthenticated client
  from spending them. A per-agent declaration cannot make that decision on an
  operator's behalf — and worse, it moves the decision to the party with no
  stake in the credentials. The flag is also what makes the capability
  answerable from OUTSIDE the bundle: with it, "can this server be handed an
  arbitrary agent?" is one env var; without it, the answer is whatever every
  deployed bundle's resolver happens to read.

## What the consumer of `?host=1` should do

Nothing. `?host=1`, `startHostSession`, `buildHostAgent` and `createHostServer`
all stand. `5-behaviour-eval-tier.md`'s level 1 should drive `?host=1` with
`AAI_ALLOW_HOST=1`, exactly as the external harness does today, and its own open
question ("does level 1 use host mode?") is answered yes with nothing pending.
