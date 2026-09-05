---
"@alexkroman1/aai-runtime": minor
---

Move OTLP span export into the runtime, so self-hosted and `aai dev` agents can point at a collector — not only the managed platform. The OpenTelemetry packages are optional peer dependencies loaded through a dynamic import, so nothing is installed or constructed unless a deployment enables tracing. Adds the `@alexkroman1/aai-runtime/tracing` subpath, and joins a model call to the request that caused it by forwarding W3C `traceparent` across the platform hop.
