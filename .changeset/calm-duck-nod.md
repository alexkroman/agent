---
"aai-server": patch
---

Forward the OTLP metrics variables (OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, OTEL_EXPORTER_OTLP_METRICS_HEADERS, OTEL_METRICS_EXPORTER) to agent guests, so a guest exports per-reply metrics to the platform's collector; a metrics-only endpoint now arms the forward too.
