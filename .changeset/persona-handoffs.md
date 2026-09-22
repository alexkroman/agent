---
"@alexkroman1/aai": minor
---

Add personas and handoffs — a roster of speakers one session hands the caller between.

`persona()` declares a speaker (its own instructions, tools and two model knobs), `personas([...])` declares the roster, and `agent({ personas })` lowers it into the tool table: every persona's tools wrapped in an execution gate that refuses while another persona speaks, plus one minted `handoff` tool the model routes with. A tool body hands off in code with `desk.handoff(ctx, target, { note })`; the active persona is a session slot, so a resumed session comes back to the persona it left on. The runtime appends the active persona's section to the prompt per model step, pushes a changed section to a transport that holds its prompt as session state, and applies the persona's `toolChoice`/`temperature` per step on the pipeline. A dialog state may pin a persona with `DialogStateSpec.persona`. `front-desk-agent` is the worked example.
