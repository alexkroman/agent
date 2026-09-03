---
"@alexkroman1/aai-runtime": patch
"aai-server": patch
---

Carry a W3C traceparent on every guest-to-platform RPC, and read it at the route. The busiest of those calls costs ~840ms of server time and that was a total with no breakdown: withReserved measures the server's half (how long the admin reservation waited, how long the statement ran) and the rest of the wall clock — the proxy, the round trip, anything queued before the handler ran — was unaccounted. Both halves are now measured; what was missing was the ability to put one beside the other, since a busy replica writes hundreds of these lines a second and a timestamp cannot correlate them. The runtime mints one span per call and logs its elapsed at debug, the platform route puts the trace id on every line withReserved writes, and 863ms against a waited+work of 43ms is a conclusion neither side could reach alone. W3C rather than a private header so an OTEL collector later reads these spans for free. ReservedCall declares the trace as a required key with an optional value, so a new platform route cannot forget to look for one.
