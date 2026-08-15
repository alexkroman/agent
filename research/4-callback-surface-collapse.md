---
issue: TODO
status: proposed
last_updated: "2026-08-14"
---

# Collapse the session callback surface

`host/` and `sdk/` declare **51 distinct `on*` option names**, and **78 of the
occurrences are inside five test harnesses** that exist to satisfy them. Once
`3-session-event-stream.md` ships a hook surface over the session's own event
vocabulary, the session-level observers among those 51 have somewhere to go —
and the test scaffolding shrinks faster than the production code does.

This is the deletion pass 1-3 can unlock but cannot perform, because each of
them has to keep the old path working while it lands.

**Depends on `3-session-event-stream.md`.** There is nothing to move the
observers *to* before that ships.

## Why this is its own plan and not a line in doc 3's scope table

Two reasons, and the second is the one that decides it.

It is too big to co-land. The 51 names span ~10 production modules
(`runtime.ts`, `s2s-transport.ts`, `pipeline-llm-stream.ts`,
`pipeline-transport.ts`, `ws-handler.ts`, `session-core.ts`, the provider
adapters) plus five test harnesses. Doc 3 already changes the protocol union,
the reconnect path, and adds a subscriber surface; adding a ~15-file callback
audit to that makes the whole thing unreviewable, and this half has no
user-visible behaviour to justify the risk.

And **a pure-deletion plan is the kind this repo has already watched sit**. The
root guide's "Open testability work" carries exactly one entry — the 47
`console.*` calls in `aai-server` — deliberately deferred because it "touches
~25 files and changes production log wiring, which should not land inside a test
-quality change." That reasoning is right, and the outcome is that the work has
not happened. So see "The count has to be a ratchet" below; without that
mechanism this document is a backlog item wearing a plan's frontmatter, which
`research/README.md` names as the failure mode of this directory.

## The measurement

Distribution of `on*` declarations across the package (excluding `.test.ts`):

| file | count | kind |
| --- | --- | --- |
| `host/_test-utils.ts` | 20 | test fake |
| `host/runtime.ts` | 19 | session wiring |
| `host/transports/s2s-transport.ts` | 16 | transport |
| `host/integration/_pipeline-fuzz-model.ts` | 16 | test fake |
| `host/_s2s-test-utils.ts` | 15 | test fake |
| `host/transports/_pipeline-transport-harness.ts` | 14 | test fake |
| `host/integration/_s2s-fuzz-harness.ts` | 13 | test fake |
| `host/transports/pipeline-llm-stream.ts` | 11 | transport internals |
| `host/transports/pipeline-transport.ts` | 7 | transport |
| `host/runtime-types.ts` | 5 | session wiring (types) |
| `host/ws-handler.ts` | 4 | session wiring |
| `host/transports/pipeline-stream-parts.ts` | 4 | transport internals |
| `host/transports/pipeline-user-speech.ts` | 3 | transport internals |
| `host/text-agent.ts` | 3 | session wiring |
| `host/_timer.ts` | 3 | utility |
| `host/transports/pipeline-providers.ts` | 2 | provider adapter |
| `host/session-core.ts` | 2 | session wiring |
| `host/providers/tts/assemblyai.ts` | 2 | provider adapter |

**The count is `aai`'s alone, and that is worth stating so nobody audits the
wrong package.** `aai-server` declares no session-level `on*` in non-test source:
its names are `onChange`/`onResync` (the platform change stream),
`onSandboxLost`/`onExit`/`onShutdown` (lifecycle), `onRetry`/`onFailedAttempt`,
and the RPC transport's `onRequest`/`onNotification`. The session-level names
that DO appear there — `onToolCall`, `onReplyDone`, `onSpeechStarted` — are all
inside test files, because the platform runs no sessions.

**The five test fakes are the finding.** Every callback has to be stubbed in
every harness that stands in for the thing that fires it, so the surface has a
multiplier: 78 of the occurrences are scaffolding whose only job is to satisfy
the shape. That is the same economics `createToolContext` was built on — it
"replaced the same eight-field stub in four template suites, two of which reached
for `{ … } as unknown as ToolContext`", which is the cast that stops reporting
when a field is ADDED.

Note also that `knip` is currently CLEAN, so none of these is dead today. Every
one has a caller. This is not a dead-code sweep; it is a surface consolidation,
and each removal has to move a real consumer onto the hook surface.

## The classification, and what does NOT go

Three groups, and only the first is in scope. Getting this boundary wrong would
turn a consolidation into an abstraction nobody wants.

- **Session-level observers → hooks.** Callbacks whose payload mirrors a protocol
  event and whose consumer only observes: `onReplyStarted`, `onReplyDone`,
  `onCancelled`, `onSpeechStarted`, `onSpeechStopped`, `onUserTranscript`,
  `onUserTranscriptPartial`, `onAgentTranscript`, `onAgentTranscriptPartial`,
  `onToolCall`, `onToolCallDone`, `onToolResult`, `onPlaybackProgress`, `onIdle`,
  `onSessionEnd`, `onSessionReady`. Concentrated in `runtime.ts`,
  `runtime-types.ts`, `ws-handler.ts`, `session-core.ts` — the ~30 that doc 3's
  subscriber surface is for.
- **Transport internals stay.** `pipeline-llm-stream.ts` (11),
  `pipeline-stream-parts.ts` (4), `pipeline-user-speech.ts` (3) use `on*`
  parameters as ordinary function decomposition, not as an observability surface.
  Routing them through an event stream would put the transport's own control flow
  through a log, which is strictly worse: it is a hot path, and an observer that
  can be subscribed to is an observer that can be *replaced*.
- **Provider adapter contracts stay.** `onSttPartial`, `onSttFinal`, `onSttError`,
  `onTtsAudio`, `onTtsWords`, `onTtsBoundary`, `onTtsError`,
  `onSynthesisComplete` are the shape a provider opener implements
  (`providers/_utils.ts`'s session shell). They sit BELOW the session and are what
  a new provider is written against — see the root guide's rule that adding a
  provider means "an opener in `host/providers/{stt,tts}/` built on the shared
  session shell."

So the target is not zero. It is **the session-level group**, and the honest
first estimate is 51 → ~25, with the 78 test-fake occurrences falling by roughly
the same proportion.

## The count has to be a ratchet

This is the mechanism that makes the difference between this landing and this
being read once. The repo has the pattern three times over and it works:
`escape-hatch-baseline.json`, `guard-invariants-baseline.json`, and
`contracts/internal-surface.json` — and the last one is the proof, having gone
from **74 to 3** because somebody counted it. As that section puts it, "counting
them is what got them fixed."

So: commit the per-file `on*` count as a baseline that may shrink and may never
grow, with `--update` that refuses to raise, exactly like the other three. Two
properties to carry over:

- **Per-file, not a grand total.** The escape-hatch gate was total-based first and
  passed a branch that removed one hatch and added another elsewhere; the per-file
  version caught it by A/B.
- **A run under budget WARNS**, naming the entries to give back — unclaimed
  headroom is a callback the next branch gets for free.

The baseline also has to exclude the fakes' own file or it scores its own
scaffolding, the same trap `escape-hatch-baseline.json` hit when its first
per-file run counted the baseline file's own pattern names as four fresh hatches.

**It should be a `guard-invariants` rule, and its number is 14 — not 13.** That
answers the first open question below: `guard-invariants-rules.mjs` already owns
the per-file baseline machinery, the `--update`-only-lowers contract, the
under-budget warning and the gate-under-the-gate spec
(`guard-invariants-gate.test.ts`, which demands a positive sample and a negative
twin), and it is already wired into `check.sh` AND the CI check job — so a rule
costs no new script, no new baseline file, no wiring and no new guard. **13 is
taken** ("no template import escaping its template dir"), and rule IDs are
STABLE, so `2-durable-session-state.md` retiring rule 6 does not free a number to
reuse. The next rule in this repo is 14 whatever ships first.

**Two other ratchets should move in this change, and the gates enforce that
rather than trusting it.** `escape-hatch-baseline.json` holds entries in four of
the five harnesses this plan empties — `host/_test-utils.ts` (one `biome-ignore`,
one `as unknown as`), `_pipeline-transport-harness.ts` (the same pair),
`_pipeline-fuzz-model.ts` and `_s2s-fuzz-harness.ts` (one each), plus
`runtime-types.ts`'s `biome-ignore` — and a run UNDER budget warns, naming what
to give back. And the file-length caps are where this plan's value shows up
first: `runtime.ts` (489) and `session-core.ts` (494) sit within 11 lines of the
500 cap with an empty allowlist, so doc 3 cannot add a hook surface to either
without room this deletion is what creates. See "Two files this cannot grow"
there.

## What else 1-3 unlock, and where it belongs

Kept here so the answer is written down once, not so it all lands here:

- **The client-side history replay path** — the `history` client event
  (`sdk/protocol.ts:330`), `SessionCore.onHistory`, `transport.seedHistory`, and
  `aai-ui/session-core.ts:223-228`. Deletable once doc 3's stream is
  authoritative. **Belongs in doc 3**, which already lists it: it is the thing
  that proves the stream works, so landing it separately would mean shipping a
  stream nothing relies on.
- **`_state-sync.ts`'s `WeakMap` dedup** — keyed on the state object to avoid
  flooding the socket. An indexed stream gives the same guarantee positionally.
  Small; **rides doc 3**.
- **`capLlm` and index-trimming** — the tool-call/result pair-alignment logic
  exists only because history is trimmed by array index. Compaction retires it.
  **Belongs in the compaction plan**, which is not yet written and which depends
  on doc 3's envelope for its `compaction.requested`/`completed` events.
- **The `template-tools` konsistent convention** — already in doc 1's scope,
  where it belongs: discovery makes the export name unobservable, so the
  convention has nothing left to check.

## Scope

| Change | Where |
| --- | --- |
| Audit all 51 by group; move the session-level set onto hooks | ~6 production modules |
| Delete the corresponding stubs from the five harnesses | `_test-utils.ts`, `_s2s-test-utils.ts`, `_pipeline-transport-harness.ts`, `_pipeline-fuzz-model.ts`, `_s2s-fuzz-harness.ts` |
| Per-file `on*` count as `guard-invariants` **rule 14** (not a fourth baseline file — see above) | `scripts/guard-invariants-rules.mjs` + its baseline and gate spec |
| Give back the four harness escape-hatch entries the deletion frees | `scripts/escape-hatch-baseline.json` |
| Epoch bump as `--drop` for whatever of this is public | `contracts/` |

## Open questions

- ~~**Is the ratchet worth a fourth baseline file?**~~ **Settled: no — it is
  `guard-invariants` rule 14.** See "The count has to be a ratchet" above; the
  draft of this question said rule 13, which is taken.
- **Does the hook surface need to be sync?** Several of these callbacks fire on
  the audio path (`onPlaybackProgress`, `onAudioChunk`) where an async subscriber
  would add a microtask per frame. Doc 3 excludes audio from the durable stream;
  this plan has to decide whether those callbacks stay as callbacks for the same
  reason.
- **Is `_timer.ts`'s trio (3) in or out?** It looks like a utility rather than
  either group, and utilities taking `on*` parameters are how the codebase
  decomposes generally — which is an argument that the target should be scoped by
  MODULE ROLE rather than by counting every `on*` in the package.
