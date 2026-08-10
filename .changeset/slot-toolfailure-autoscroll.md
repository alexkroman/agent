---
"@alexkroman1/aai": minor
---

Extract five patterns the templates had each re-implemented into the SDK, and
convert the templates to them.

- `sessionSlot(key, create)` (root export) — a typed named slot inside
  `ctx.state`, with `get`/`set`/`reset` plus `read`/`projection` for the
  `syncState` side. Every stateful template declared its own
  `type StateSlot = { x?: T }` and a `ctx.state as StateSlot` cast with a lazy
  `??=` init; a slot moves that narrowing into one seam, and `SlotStateOf<typeof
  slot>` is the one spelling of the state type.
- `ToolFailure` / `isToolFailure` (root + `/utils`) — the `{ error: string }`
  shape tools return for a recoverable failure, and the guard that narrows a
  propagated one. Distinct from `toolError`, which returns the host's
  pre-serialized wire string; its doc now says so.
- `pushCapped(list, item, max)` (root + `/utils`) — append to a `ctx.state`
  list holding a cap, in place.
- `@alexkroman1/aai/testing` — a new subpath exporting `createToolContext` and
  `createUnusedDb` for testing a tool's `execute` in isolation. Replaces the
  hand-rolled `{ … } as unknown as ToolContext` stub, which omits fields and
  stops reporting when one is added.
- `useAgentState(fallback)` (`@alexkroman1/aai-ui`) — a new overload returning
  the fallback instead of `null` before the first push, so a client that
  supplies the empty projection needs no branch for that frame. The no-argument
  overload is unchanged.
- `AutoScroll` (`@alexkroman1/aai-ui`) — the stick-to-bottom scroll container
  `MessageList` already used, exported for clients that render their own chat
  chrome. Replaces a `scrollIntoView` effect, which fights a reader who scrolls
  up and misses growth that is not a new message.

Also fixes an unbounded `ctx.state` list in the `infocom-adventure` template:
its command history was appended to on every move and never capped.
