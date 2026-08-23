---
"@alexkroman1/aai-runtime": minor
---

`createAgentServer` can now express what `createRuntime` + `createServer` can, and the LLM registry's writer is published.

- **`telephony` is reachable from the front door.** `createServer` defaults it to on for a voice agent, and `createAgentServer` forwarded neither it nor `page` — so every server built through the documented door, the scaffold's own `server.mjs` included, mounted an unauthenticated `WS /phone` with no way to switch it off short of abandoning the wrapper and restating by hand every field it derives. `telephony`, `page` and `uploadBroker` are forwarded now, and `page` DEFAULTS TO THE AGENT'S OWN: a `page: "static"` agent used to get the voice surfaces and a voice `GET /client-config`, because nothing carried the declaration through — the same silent drop `createAgentServer` exists to prevent for `name` and `greeting`.
- **A `PassthroughServerOptions` bag can be spread into `ServerOptions`.** Its three fields were optional without `| undefined`, so `{ ...hooks }` widened each and `exactOptionalPropertyTypes` rejected the whole object (TS2379) — the one bag that exists to reach all three front doors could not be handed to any of them. `ServerOptions`' `logger`, `upgrade` and `request` accept `undefined`; existing callers are unaffected.
- **`registerLlmKind` and `LlmRegistryEntry` are on `@alexkroman1/aai-runtime`**, beside `registerSttKind` and `registerTtsKind`. All three are one mechanism, and the LLM one was published from no subpath at all while `resolveLlm` — which reads the registry it writes — was public and contracted. A host wiring a model the SDK does not ship no longer has to reach past the descriptor path.
- **`@alexkroman1/aai-runtime/internal` drops 63 re-exports nothing imports**, taking it from 99 names to 36. Every removed name is `@internal` at its declaration and was reachable only through that subpath; intra-package use is relative imports, so nothing in the repo changes. The three that stay unimported (`WakeHintOptions`, `WakeHintPublisher`, `WorldKind`) are kept because a name that IS imported has one of them in its signature.

This subpath carries no semver promise, but the removal is listed here because it is the visible half of the change.
