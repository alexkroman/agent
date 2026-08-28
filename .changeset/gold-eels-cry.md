---
"@alexkroman1/aai": major
---

Remove ctx.db. The platform provisions no database and no longer hands tool code one either: a tool or an event hook that wants SQL brings its own client and its own credential. Db survives as an @internal type — the shape the runtime's own Postgres consumers take — and createUnusedDb goes with it. Ten capability epochs were dropped, and solo-rpg loses save_game/load_game: a shipped template cannot reach a database, so no template demonstrates cross-session persistence.
