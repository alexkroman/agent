---
"aai-server": minor
"aai-guest": minor
---

Export OTLP spans, off unless an operator sets `OTEL_EXPORTER_OTLP_ENDPOINT`
(or the traces-specific one).

The platform exports one server span per HTTP request, adopting the
`traceparent` a guest already sends so the trace id on a span is the same id
`withReserved` puts on its log lines. The guest bridges the AI SDK's own
telemetry — `registerTelemetry`, not hand-instrumented spans — into the same
exporter, covering model calls, steps and tool executions for both the voice
pipeline and the studio coding agent.

Guest spans carry METADATA ONLY: latency, token counts, model id, step number,
tool names, finish reason, outcome. Prompts, completions, transcripts, tool
arguments and tool results are never recorded, and there is no switch that
records them — attributes are built from an allow-list, so content is absent
because no code path reads it.

With no collector configured nothing is constructed on either side: no
exporter, no provider, no processor, no timer, and in the guest the OTel module
graph is never imported (measured: 0.1 ms unconfigured against ~390 ms to stand
the exporter up).
