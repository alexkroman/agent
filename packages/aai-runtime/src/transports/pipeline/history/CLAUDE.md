---
summary: >-
  Pipeline history: token budgets for the request and the record, the preparer
  pipeline, and a rollback undoing its push's eviction
read_when: >-
  editing anything under `src/transports/pipeline/history/`
---

# Pipeline history

Stage map and import rules: [`../CLAUDE.md`](../CLAUDE.md). What a cut reply
leaves in history is "History records what was HEARD" there.

## History is budgeted in TOKENS everywhere; there is no message cap

- **The REQUEST** is bounded only by `context-budget.ts`, a **`prepareStep`
  preparer**, so `PipelineHistory` keeps everything (replay, resume and
  `ctx.messages` read it) and only the request is trimmed. The window is
  `ASSEMBLYAI_GATEWAY_MODELS.context` less `CONTEXT_WINDOW_RESERVE`; an UNKNOWN
  window is budgeted as the smallest the catalog carries
  (`UNKNOWN_MODEL_CONTEXT_TOKENS`), because nothing else bounds the request; the
  count is calibrated per SESSION against reported `usage.inputTokens`.
- **The RECORD** is bounded for memory only, also in tokens (`retention.ts`,
  `HISTORY_RETAIN_TOKENS` = 2 x `LARGEST_CONTEXT_TOKEN_BUDGET`), and that size
  is what makes it unable to change a request: the budget sends a suffix no
  larger than its limit, and retention always keeps a larger one
  (`retention.test.ts` states it as a property). The same bound applies in
  `../../../session/core.ts` and to a resume (`historyFromEvents`); the event
  log itself stays whole.
- **The one count left is a DISPLAY bound**: `MAX_CLIENT_MESSAGES` caps what a
  `history.restored` frame carries (`clientHistoryFrame`) and what `aai-ui`
  keeps in its snapshot.

**Preparers REGISTER into one pipeline** (`../../../_prepare-step.ts`):
`composePreparers([{ stage, prepare }, …])` layers them in `PREPARER_ORDER`
(budget → ledger → agent reset → persona → dialog → error budget →
`forceFinalAnswer`) whatever order a call site lists them in, last writer
winning per key. Writing any preparer straight into the slot silently deletes
the others, so `guard-invariants` rule 35 rejects a `prepareStep:` in this
package whose value is not a `composePreparers(…)` call; a new concern is a new
stage.

## A rollback must undo the eviction its push caused

`history.ts` keeps two views, each retained to the token bound.
`dropTrailingUser` rolls back an injected prompt (false-interruption resume,
silence nudge, `injectTurn`), and at the bound a bare pop would lose what the
push evicted. A push records what it evicted and the pop that undoes THAT push
restores it. Argued at `PushUndo`: one slot PER VIEW, recorded only for a
single-message push, consumed by IDENTITY; a tool pair `canLeadLlm` took whole
counts as part of the eviction. Oracle:
`../../../integration/pipeline-history-rollback.integration.test.ts` (driven at
a small `retainTokens`), plus two pins in `history.test.ts`.

## The ledger is DERIVED from history before every step, never stored

`ledger.ts` renders each lookup's latest successful result (keyed `tool(args)`)
as ONE system message after the newest turn — LedgerAgent's records block (arXiv
2606.20529). Rules:

- **Only for a tool set that declares a write** (`effect: "write"`);
  `transport.ts` passes no step otherwise. A write's own result is not listed;
  it marks the reads that named one of its values `(fetched before X ran)`.
- **It reads the UNTRIMMED history** (`initialMessages` + `responseMessages`),
  so a record the budget dropped stays visible, and it appends to the list the
  budget returned (`composePreparers` chains `messages`).
- **The message is `markEphemeral`**: the AI SDK carries a step's messages into
  the next, and `composePreparers` strips it there, or it piles up and breaks
  the budget's prefix check. `stream.ts` sets `allowSystemInMessages`, without
  which `streamText` refuses it.
- **Descriptive wording only.** A directive first draft ("look it up again
  before relying on it") raised re-fetching on tau2 retail; the module doc has
  the numbers.
