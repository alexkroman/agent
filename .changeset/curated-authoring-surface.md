---
"@alexkroman1/aai": major
---

Cut the root entry point down to the authoring API, and give `sessionSlot` the
two methods a slot-backed tool module was writing by hand.

**Breaking.** `@alexkroman1/aai` exported 175 symbols, 71 of them `@internal`,
and 160 of them unused by any of the fourteen shipped templates — eleven
distinct symbols covered every one. It exports 92 now, and none is `@internal`.
Nothing is deleted; everything subtracted moved to the subpath that owns it:

- Framework budgets with no `agent()` field to set (the client-audio constants,
  provider connect deadlines, wire caps, `AGENT_CSP`, `WS_OPEN`, the
  `WS_NORMAL_CLOSURE`/`MAX_*_BYTES` family) → `@alexkroman1/aai/internal`.
- The slug contract (`VALID_SLUG_RE`, `RESERVED_SLUGS`, `MAX_SLUG_LENGTH`,
  `PREVIEW_SLUG_SUFFIX`), `linkConfirmationCode`, and the wire helpers
  (`capToolResult`, `toArgsRecord`, `isTextAssetPath`, `normalizeSpeechText`,
  `omitUndefined`) → `@alexkroman1/aai/utils`, where the CLI and the platform
  already read them.
- `StandardSchemaV1`, `StandardSchemaResult` and `StandardSchemaIssue` are the
  ecosystem spec `tool()` accepts rather than something an agent declares;
  `ToolInputSchema` and `InferSchemaOutput` stay on the root.

**`toolError` is renamed `serializeToolFailure` and is `@internal` on
`/utils`.** It returns the pre-serialized wire string, so
`isToolFailure(toolError(m))` was `false` — a trap under a name that read as
the constructor for the shape the guard tests, and used by none of the
templates despite its own doc pointing authors at it. The new `toolFailure(message)`
is that constructor, and pairs with `isToolFailure`.

**New:** `slot.tool()` and `slot.updateTool()` hand `execute` the live slot
value as its second argument, so a tool in its own module needs neither a
`ToolContext<SlotStateOf<typeof slot>>` annotation nor an opening
`slot.get(ctx)` — the two lines that opened every tool in every stateful
template. `updateTool` runs the body inside `slot.update`, for a body that
awaits. `slot.state` is the `AgentDef.state` factory, so
`state: cartSlot.state` replaces the hand-written
`() => ({ [slot.key]: slot.create() })` that four of the five slot-backed
templates had omitted.

Three capability epochs move with it (`pnpm check:api-contracts`): `tool` and
`defaults` to v2 with v1 DROPPED — their frozen examples no longer compile, and
the recorded reasons say why — and `state` to v2 with **v1 retained**, since
`slot.state`/`slot.tool`/`slot.updateTool` are additions and the epoch-1 example
still compiles beside the epoch-2 one. The `internal-surface` ratchet falls from
74 to 3: the only `@internal` names still reachable from a public subpath are
`capToolResult`, `isTextAssetPath` and `toArgsRecord` on `/utils`.
