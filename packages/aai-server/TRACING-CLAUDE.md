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

**Guest spans now adopt the platform's span as parent**, so a model call and
the platform HTTP request that caused it are ONE trace. Three things had to be
true together, and any one of them missing puts it silently back to two:

- `guest-forward.ts` injects the platform's ACTIVE span context on the hop
  (`withTraceparent`). The header is minted, never relayed — this hop's callers
  are the open internet and third-party webhook senders, so forwarding an
  inbound `traceparent` would let any of them choose the trace id a tenant's
  spans are filed under.
- `createRuntimeServer` calls `adoptRequestTrace(req.headers)` at the top of
  every request (`aai-runtime/_request-trace.ts`).
- the telemetry bridge's operation span parents to that context rather than
  hard-rooting at `ROOT_CONTEXT`, which is what it used to do.

The platform RPC hop, the workflow journal and the STT/TTS sockets still emit
no spans of their own — only the HTTP span that contains them.

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

## Verified against a live collector

`aai-runtime/src/tracing-collector.scenario.test.ts` stands one up — a real
socket answering `POST /v1/traces` — drives a real `generateText`, and asserts
the delivery: one request, `application/x-protobuf`, at the `/v1/traces` path
the exporter appends, carrying the service name and the `gen_ai.*` attribute
names. It also re-asserts the redaction claim **of the bytes on the wire**,
which is the only place a serialization bug could put content back.

That replaces a "Not verified" heading which said no live collector had ever
been exercised, and finding one thing was the point of doing it:
**`startTracing(env)`'s argument is only the PREDICATE.** The exporter resolves
its own URL, headers and timeout from the REAL `process.env` — deliberately, so
this repo never re-parses a grammar the library owns — so a test that passes a
custom endpoint in the argument arms the gate and then exports to OTel's
DEFAULT endpoint (`localhost:4318`). It looks like it works. The scenario test
therefore stubs `process.env`, and a caller pointing this at a collector must
set the real environment rather than the parameter.
