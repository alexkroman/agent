---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
---

Add first-class per-reply metrics.

- **`metrics.collected` session event** (pipeline mode): one frame per reply with STT endpointing delay, LLM time-to-first-token / duration / steps / tokens, TTS time-to-first-byte / characters, and the committed-turn → first-audio `latencyMs`. A stage that did not happen is absent, never zero. It reaches the client, `agent({ events })` hooks and the runtime's metrics sinks.
- **`createMetricsCollector()`** on `@alexkroman1/aai`: folds frames into a summary (count/min/max/mean plus p50/p95 over a bounded window, and token/character totals).
- **Metrics sinks** on `@alexkroman1/aai-runtime/tracing`: `registerMetricsSink` (process-wide, shared across both runtime copies in a deployed guest) and `otelMetricsSink(meter)`, which records `aai.*` histograms and counters onto any OpenTelemetry `Meter` — a Prometheus `MeterProvider` included.
- **OTLP metric export**: `startTracing` now also exports metrics when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is set (`OTEL_METRICS_EXPORTER=none` opts out). It needs two new optional peers, `@opentelemetry/sdk-metrics` and `@opentelemetry/exporter-metrics-otlp-proto`; without them it logs one line and traces carry on.
