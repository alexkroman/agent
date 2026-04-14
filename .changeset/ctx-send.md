---
"@alexkroman1/aai": minor
"@alexkroman1/aai-ui": minor
"aai-server": patch
"aai-templates": patch
---

Add ctx.send for real-time tool-to-client events

Tools can now push arbitrary events to the browser client via `ctx.send(event, data)`. Events flow over the existing WebSocket as `custom_event` messages. The new `useEvent` React hook subscribes to named events. Migrated solo-rpg, pizza-ordering, dispatch-center, and night-owl templates from `useToolResult` to `ctx.send` + `useEvent`.
