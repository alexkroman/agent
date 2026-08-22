---
"@alexkroman1/aai": major
---

Cut the authoring surface to what an agent.ts writes, and fix the docs that contradicted the code.

**Docs that were telling authors false things.** `preemptiveGeneration` said `Defaults to true` in its first paragraph and `turned the default OFF` in its sixth (the runtime default is `false`); `DEFAULT_MAX_TURN_SILENCE_MS` rendered as 3500 while its own prose argued for 3000 three times; and `workflow()`'s example showed `agent({ tools })`, which `InlineToolsMisuse` makes a compile error. Every field default is now an `@defaultValue` tag carrying the literal value instead of a link to follow.

**Endpointing is reachable without replacing a stage.** `agent({ maxTurnSilenceMs })` — the pause-tolerance knob — desugars to `stt: assemblyAIStt({ … })`, the same way `voice` already did. It used to cost a whole descriptor, which silently opted the stage out of the default fill. `assemblyAIPipeline()` takes the pair too.

**`flow()` is `dialog()` and `graph()` is `procedure()`.** `dialog` / `procedure` / `workflow` names the three by their jobs; `flow` sat in one barrel beside `workflow` meaning something else entirely.

**Three subpath moves, all by AUDIENCE.** `@alexkroman1/aai/step` is new and holds the `"use step"` vocabulary; `/utils` keeps the fifteen helpers a tool body writes (it was 79 serving three readers); the platform contracts and wire helpers are on `/internal`, which is now zod-free; and the workflow RUN vocabulary is on `/workflow-api`, whose reader is a page or a script. The ten types behind `AgentParams`' arms left the root barrel — they implement a compile error and every message is unchanged. Root exports: 120 → 94.
