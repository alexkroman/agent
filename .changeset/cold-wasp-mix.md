---
"@alexkroman1/aai-runtime": patch
---

createAgentServer answers HEAD /health (the verb a load-balancer check sends by default, which fell through to a 404) and logs a Serving line naming the routes it mounts. The scaffold's server.mjs now reports a boot configuration failure — a missing provider key, an unreachable DATABASE_URL, a port in use — as a message plus the fix and a non-zero exit, instead of a traceback into bundled dist internals, and warns that a databaseless deployment needs sticky sessions behind a load balancer.
