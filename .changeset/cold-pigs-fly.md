---
"@alexkroman1/aai": major
---

Remove per-app databases from the platform entirely. The platform provisions no database for a tenant: `aai storage enable/disable/status`, the studio's Database card and pane, the `/:slug/storage` routes and the eleven app-db modules behind them are gone. An author who wants a database puts a DATABASE_URL in their own secrets, pointing at their own provider, and it now reaches the guest untouched — it used to be overlaid LAST, so enabling storage silently beat whatever the author had set. Durable state did not go with it: durable workflow runs and turn-level durability (session slots, the session event log) are on the platform's own database, reached over HTTP with the sandbox's bearer. The connection budget loses its only tenant-scaled term, which was 28 of 40 spoken for by two apps.
