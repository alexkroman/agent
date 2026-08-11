---
"@alexkroman1/aai-cli": patch
---

Route a static agent's workflow API. A page mounted with page() builds its request URLs from location, so on the platform its calls land on /:slug/workflows/* and under aai dev they land on Vite — neither of which had a route. Both now forward to the agent; the platform brokers the sandbox first, streaming bodies so blob uploads are not buffered.
