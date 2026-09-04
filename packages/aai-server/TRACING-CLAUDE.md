# Tracing — OTLP span export

A sibling of `CLAUDE.md` rather than a section in it, for the reason the guide
gives for `MODAL-CLAUDE.md` and `SCHEMA-CLAUDE.md`: this is REFERENCE — which
env vars turn it on, which spans exist, what an operator must not assume — not
a rule that has to be resident in every agent's context. It is also the only
shape that fit: that guide sits 81 characters under the 120,000-char cap.

## It is OFF unless a collector is configured, and that is the whole switch

`OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is the
predicate. Unset, nothing is constructed: no provider, no exporter, no timer,
no import. `tracing.test.ts` proves that with an exporter FACTORY that must
never be called — an instance would already exist by the time a spy could see
it, so asserting "no spans" would pass over a provider that was built and
merely idle.

Everything else — headers, the `/v1/traces` suffix rule, timeouts — is left to
the exporter, which already implements the spec. The env is read here only as a
predicate, never re-parsed.

## Two span sources, and they are not yet ONE trace

| Source | Spans | Where |
| --- | --- | --- |
| `@hono/otel` | one SERVER span per platform HTTP request | `aai-server` |
| AI SDK telemetry | `ai.generate`, `ai.step`, `ai.languageModelCall`, `ai.toolCall <name>` | `aai-guest` |

**Guest spans currently root their own traces.** `guest-forward.ts` is an
allow-list and does not carry `traceparent`, so no request arriving at a guest
has a parent to adopt. The propagator IS installed on both sides, so a parent
is honoured the day one arrives — but until `guest-forward.ts` forwards the
header, a model call and the HTTP request that caused it are two traces. Do not
describe this as end-to-end tracing; it is not, yet.

The platform RPC hop, the workflow journal and the STT/TTS sockets emit no
spans of their own — only the HTTP span that contains them.

## Spans carry NO conversation content, and the SDK will not do this for you

`recordInputs` / `recordOutputs` exist in `ai@7` and are enabled by default —
**they are not filters.** They are advisory fields passed THROUGH to the
integration, and every event carries the conversation regardless: `messages` on
the start events; `content`, `text`, `toolCalls`, `toolResults` on the ends;
tool events carry `messages` plus `toolOutput.output`. An integration that
serialized its event would ship every transcript to the collector.

So attributes are built from an **allow-list of names**. Content is absent
because no code path reads it, not because a flag asks nicely. There is no
opt-in to capturing it: the safe setting is the only setting.

This is a voice runtime — transcripts are user data, and some deployments carry
contractual limits on where they may travel. `tracing.test.ts` asserts it with
distinctive prompt, completion, tool-argument and tool-result strings and fails
if any reaches a span; one leaking attribute fails four specs. Keep it that
way, and extend that test with any attribute you add.

## The OTLP credential shares the sandbox's trust level

`OTEL_EXPORTER_OTLP_HEADERS` reaches the guest through `agentBootEnv` into the
guest's exec env. It is NOT in the agent env surface — `ctx.env` is built from
the boot file at `AAI_AGENT_ENV_PATH` and `process.env` is never merged in — so
tool code written against the SDK cannot read it.

It is not hidden from the sandbox, though: it sits beside `AAI_GUEST_TOKEN`, so
a `run_code` body, or code reaching around the SDK for `process.env`, can read
it. The container is the boundary. **Scope this credential ingest-only.**

## Cold start

The OTel graph is behind a dynamic `import()` inside the configured branch, and
it survives tsdown bundling as a real lazy init (`init__guest_tracing_otel`, an
`__esmMin` wrapper invoked from exactly one place). Measured: **0.1–0.2 ms**
unconfigured, **~373–404 ms** configured. That ~390 ms is why the harness
DETACHES rather than awaits — awaiting would roughly double a ~345 ms boot.

One known rough edge: the image's V8 compile-cache warm-up exits before tracing
starts, so a configured guest compiles the OTel graph cold. Harmless for the
default path; fixable by extending warm-up.

## Bundle cost

`dist/harness.mjs` 15.24 MB → 15.82 MB raw (+561 KB, +3.8%), 1.96 MB → 2.05 MB
gzip (+85.5 KB, +4.5%). Under the 10% budget threshold, and no PUBLISHED
package gained a runtime dependency — all five OTel deps are `aai-server`'s and
the guest bridge's.

## Not verified

No live collector has ever been exercised. The OTLP wire path — protobuf
encoding, real HTTP — is the library's, not something a test here covers. Point
it at a real collector before treating this as working.
