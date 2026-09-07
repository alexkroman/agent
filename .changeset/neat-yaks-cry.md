---
"aai-templates": patch
"@alexkroman1/aai-cli": patch
---

Templates: remove dead code, adopt the SDK helpers three of them still re-implemented, and cut wasted work on the voice and workflow paths.

User-visible in the templates `aai init` copies: hotel-desk prints money with thousands separators (its own formatter had none, so a multi-night bill read $1240.00) and validates every date field through its schema, so a bad date is refused before the tool body runs and the model is told why; podcast-digest bounds its feed-read fan-out instead of opening one request per link at once; solo-rpg's projection no longer sends the browser the goal and mood of acts the player has not reached; night-owl's spinner clears when the tool settles rather than when the list happens to grow.
