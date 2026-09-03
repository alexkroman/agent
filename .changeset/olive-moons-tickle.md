---
"aai-server": minor
---

Export OTLP spans for the platform's HTTP surfaces, off unless an operator sets
`OTEL_EXPORTER_OTLP_ENDPOINT` (or the traces-specific one). The span adopts the
`traceparent` a guest already sends, so the trace id on an exported span is the
same id `withReserved` puts on its log lines. With no collector configured
nothing is constructed — no exporter, no provider, no processor, no timer, and
no middleware in the request path.
