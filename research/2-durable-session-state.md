---
issue: TODO
status: implemented
last_updated: "2026-08-14"
---

# One session-state store, with a Postgres and a memory backend

> **Implemented.** What landed differs from this plan in one decision and in two
> details, all recorded here rather than only in the code:
>
> - **The write model is a SYNCHRONOUS DRAFT, not a functional replace** — this
>   document's own first draft, re-reversed. The argument against the draft was
>   that "the mutator body is async by design", and this same section then RULES
>   that the mutator is synchronous; a synchronous draft has no lost-update
>   window either, and is atomic for the same reason a replace is. What decided
>   it was `retail`: its ~25 mutation sites are deep in-place writes reached
>   through lookup helpers (`order.status = …`, `method.balance = money(…)`), so
>   a replace means hand-written spread chains three and four levels deep,
>   several touching two subtrees at once. Every property the plan wanted is
>   kept — one observable commit point, a mutator that throws stores nothing,
>   `after` on the complete value, change detection by comparison — and two of
>   the costs it lists are real: one `structuredClone` per mutating tool call
>   (~106 KB on retail, against a ~6.2s tool turn), and no lock, because a
>   synchronous window has nothing to serialize. `updateTool` therefore SURVIVES
>   as the mutating half, with `tool` as the reading half.
> - **`get` returns `Readonly<T>`, not `DeepReadonly<T>`.** A deep type
>   propagates through every domain helper an agent declares
>   (`orderTotal(cart)`, `incidentSummary(incident)`) for a guarantee the
>   runtime FREEZE already gives at every call site, typed or not. Readonly
>   modifiers are not checked in assignability, so the shallow type still passes
>   to a helper over the mutable shape and costs the templates nothing — and the
>   freeze found four mutating tools the type could not see, each writing inside
>   a helper.
> - **The platform sweep is a pg_cron job and does NOT reuse the wake hint's
>   cross-tenant reader.** That reader is platform-DB-only (`workflow-wake.ts`
>   warns about `APP_DB_URLS` for the same reason), read-only under a leader
>   lock on the request-serving process, and needs a replica running; a delete
>   over app schemas expressed in the database needs none of that.
>   `aai-server/_session-state-sweep.ts` carries the argument. What IS shared is
>   the table name, from the SDK constant both ends derive from.
>
> Two things landed that were not planned. A nested `set`/`reset`/`update` on one
> slot inside an open window THROWS rather than being silently overwritten by the
> outer draft — `pizza-ordering`'s `resetOrder` was doing exactly that. And four
> older contract epochs were dropped although they still COMPILE, because their
> `updateTool` bodies are async: a case `pnpm typecheck`, this mechanism's whole
> gate, cannot see.

## The gap is exactly one map

Three things make up a live session's state, and only one of them is lost:

| What | Where | Survives a redeploy? |
| --- | --- | --- |
| conversation history | `let history: Message[]` — `aai/host/session-core.ts:143`, closure-local | **yes** — the client replays it (below) |
| `ctx.state` / slot values | `Map<string, Record<string, unknown>>` — `aai/host/runtime.ts:204` | **no** |
| provider sockets, turn machine, audio pacer, heard cursor | the transport | no, and cannot |

The third row is out of scope at any price: a half-spoken reply has no
representation in a database and the caller has already heard silence. What is
in scope is the second, and the loss is silent and partial — which is worse than
a clean failure, because the transcript comes back intact and only the state is
missing.

## The client is already the durable store for history

Worth stating because it removes what looked like the larger half of the work.
`aai-ui/session-core.ts` already handles both halves of reconnecting to a
*replacement* sandbox, and its own comments say so:

- **Re-brokering per attempt** (`currentWsUrl`, lines 232-246): `GET
  client-config` is re-fetched on every reconnect attempt, so when the sandbox is
  replaced the reconnect lands on the replacement.
- **History replay** (`onServerConfig`, lines 223-228): on a reconnect the client
  sends `{ type: "history", messages }` from its own snapshot — a real protocol
  frame end to end (`sdk/protocol.ts:330` → `host/ws-handler.ts:131` →
  `host/session-core.ts:287` → `pushMessages` + `transport.seedHistory`).

The same trick cannot be reused for `ctx.state`: history is append-only and every
message already crossed the wire, whereas state is server-authoritative and only
ever leaves as a lossy `syncState` **projection**. There is nothing on the client
to push back.

## Prior art: eve

`~/Code/eve` uses the same AI and Workflow primitives, and its `defineState`
(`packages/eve/src/public/definitions/state.ts`) is nearly our `sessionSlot`: a
named slot, an `initial` factory called on first access, `get`/`update`.
Independent convergence on the shape is good evidence the shape is right.

What differs is that eve's is durable with nothing to configure, and the
mechanism is not a state store at all. From
`docs/concepts/execution-model-and-durability.mdx:16`:

> Every turn runs as a durable workflow… eve checkpoints progress and
> **serializes durable state at each step boundary**.

Literally: `serializedContext` is a field on step *input and output*
(`packages/eve/src/execution/workflow-steps.ts:172, 317, 565`). Each step
deserializes the context, runs, re-serializes, and returns it as part of the step
result. The workflow journal *is* the store — no table, no hydration path, no
TTL sweep. That resolves the workflow-is-replayable / session-is-not tension by
making the session a workflow, rather than by bolting a store onto a session.

### Why that architecture does not transfer

eve's step boundary is a durable write on the critical path of every model call,
and it can afford that because **eve has no real-time audio path**. Its most
latency-sensitive channel answers a phone call with TwiML `<Gather
input="speech">` (`docs/channels/twilio.mdx`) — turn-based request/response,
where "the resulting transcript feeds the same eve session that SMS uses."

Our `WS /phone` is a bidirectional media stream. The pipeline transport has a
measured p50 time-to-first-token of ~1.0s and a 500ms
`interruptionMinDurationMs` barge-in budget, and it holds live STT and TTS
sockets. eve's durability further rests on parking — "the workflow suspends and
holds no compute until the input it's waiting on arrives" — and a parked voice
turn is a dropped call.

So "turn as durable workflow" is not available to the pipeline or S2S transports.
It *would* fit `text: true` mode, which has no audio path at all; that is a
separate opportunity and not this proposal.

### What does transfer

Four of eve's decisions are adopted directly, because each answers a question
this design has to answer anyway:

- **An unknown key on load is dropped with a warning**
  (`packages/eve/src/context/serialize.ts:51-53`: *"Unregistered key (e.g.
  renamed): dropping it silently loses data, so warn."*). That is the fail-open
  rule this design needs for shape drift, reached independently, for the same
  reason.
- **Serializability is per-slot, with an escape hatch.** Each `ContextKey` may
  carry a `codec`; without one the value "must already be JSON-safe". So the JSON
  constraint is a default a slot can opt out of. eve also **throws** when the
  same name registers once with and once without a codec
  (`packages/eve/src/context/key.ts:80-98`), because the codec-less key wins the
  registry and the value is then stored raw — worth copying.
- **A value that must NOT be stored gets a different class of key, not a codec.**
  `ContextContainer` holds `_durableValues` and `_virtualValues` separately
  (`context/container.ts:33-34`): a virtual value shadows the durable one, is
  cleared per step, and is "excluded from serialization". That is a cleaner answer
  than a per-slot opt-out for the case we will certainly have — a provider handle,
  an open socket, anything whose lifetime is one turn — because it makes
  "unstorable" a property of the SLOT's declaration rather than of a codec
  somebody has to remember to omit.
- **The key registry is rooted on `globalThis`** via `Symbol.for`, because Nitro
  can inline more than one evaluated copy of `key.ts` and a key registered by one
  copy is invisible to the other — at which point serialization "silently drops
  entries at step boundaries". We have the same hazard by a different route:
  it is why `_tool-discovery.ts` uses `import.meta.glob` over Node resolution,
  "which would hand them a second copy of the SDK, so a slot's module state would
  differ between the tool under test and the agent holding it." If a slot's
  identity is its key, the registry needs the same treatment.

eve's fourth decision — a **synchronous functional** `update(fn: (current: T) =>
T)` — is adopted too, which reverses this document's first draft. See below.

## One store, two backends — not a per-slot flag

Persistence is a property of the DEPLOYMENT, not of a slot. The store interface
has two implementations, selected by whether the app has a database:

- **Postgres** when `DATABASE_URL` is present — one row per `(sessionId, key)` in
  the app's own schema, over the existing `createPostgresDb`
  (`host/postgres-db.ts`).
- **Memory** otherwise, which is what `aai dev` against a project with no
  `DATABASE_URL` gets. This is `runtime.ts`'s `stateMap`, REPLACED by the memory
  backend rather than left beside it.

**This is the shape the repo already uses twice.** `configureWorkflowWorld`
picks the Postgres world when the app has a database and the local world
otherwise; the workflow upload store picks Postgres or
`.workflow-data/uploads` on the same test. One code path, two backends, chosen by
environment.

**A per-slot `persist` flag was the first draft and is rejected**, because it
recreates a failure this repo has already paid for. From
`aai-server/CLAUDE.md`, on the jsonb encoding bug:

> **the in-memory stores cannot represent the bug.** They hold JS objects, so
> the
> encoding has no analogue in them, and every unit test passed against a shape
> production never had.

A flag means memory slots keep arbitrary JS values and unobservable in-place
mutation while persisted slots are JSON and commit-based — so every test against
a memory slot passes on shapes Postgres cannot hold. Unification is what makes
the memory backend a valid test double for the Postgres one, which is the whole
reason to have one path.

### The app's schema survives sandbox replacement — verified

This is the premise the design rests on. Four facts in `aai-server`:

- The schema and role name is `app_` + the first 16 hex chars of `sha256(slug)`
  (`app-database.ts:51-53`) — **derived from the slug**, so it cannot change when
  a sandbox is replaced.
- Placement across clusters is likewise slug-derived (`pickAppDbTarget`), and
  `deprovision` follows the app's **stored locator** rather than a recomputed
  placement, so even an `APP_DB_URLS` change cannot strand an existing app.
- `DATABASE_URL` is recomposed at every sandbox construction from the stored
  `app-db:<slug>` meta plus that cluster's URL (`sandbox-resolve.ts:216-219`);
  the meta lives in Vault and outlives any sandbox.
- `provision` — which rotates the role password on **every** call — has exactly
  one caller, `storage-handler.ts:67`, the storage-enable route. **A deploy does
  not re-provision**, so a redeploy neither rotates the credential nor touches
  the schema.

One consequence to document: **disabling storage destroys persisted state**,
because `deprovision` drops the schema. Correct behaviour, and not obvious.

## Writes are a functional replace, as in eve

**This reverses the first draft of this section**, which proposed a DRAFT — the
framework clones the current value, hands the mutator the clone, commits it when
the body returns — and rejected eve's functional replace on exactly one ground:
call-site churn across 31 mutation sites and the five in-place helpers the
templates share. That ground is withdrawn. This series does not design for
backwards compatibility (`research/README.md`); the API breaks and the templates
are rewritten, so churn is not a cost being minimized. With it off the table the
draft has no argument left, and it has three costs a replace does not.

**What eve actually does, verified.** `defineState(name, initial)` returns
`{ get(): T; update(fn: (current: T) => T): void }`, and `update` is three
synchronous lines: `ensure(key, initial)`, then `set(key, fn(current))` against
a plain `Map` inside `ContextContainer` (`context/container.ts:32-61`). No clone,
no lock, no per-mutation write. Durability comes from the STEP BOUNDARY — the
container is serialized into the step result — not from `update`.

**The property worth copying is that `update` is SYNCHRONOUS.** There is no await
between the read and the write, so a read-modify-write cannot interleave with
another JS turn: it is atomic by construction, which is why eve needs no lock for
it. A draft cannot have that property, because the mutator body is async by design
— the clone-mutate-commit window spans awaits, and two drafts opened from one base
are a lost update where the old in-place model merely had a race.

**The async case is not solved by either shape, and that is the honest framing.**
A mutator that awaits between reading and writing has a stale-read window whatever
the API looks like. So the rule is the one eve's signature already forces: **the
mutator is synchronous, and the await happens in front of it.**

```ts no-check
const quote = await price(cart);              // await first
slot.update(ctx, (s) => ({ ...s, quote }));   // then replace, atomically
```

Every one of our async mutators can be written that way. What remains is the case
where the read and the write genuinely must be one critical section — a value read
before the await and replaced after it can be logically stale even though the
write is atomic. eve has that exposure and does not address it; we already have
the tool for it, and `createKeyedLock`/`withLock` staying public for "serialized
work that is not a slot mutation" is a better division than making every mutation
pay for the rare one.

**What the replace deletes from this plan**, all of it machinery the draft needed
and nothing else wanted:

- the draft-aware `get` and the retail-shaped test that had to fail without it;
- a `structuredClone` per mutation, including retail's ~106 KB;
- the per-(slot, session) lock held across clone-mutate-commit, and extending it
  to `slot.tool`, which does not take a lock today.

**Change detection and the serializability check both survive.** The replace hands
the framework the previous value and the next one in the same turn, so "write only
if it changed" is a comparison whose inputs are already in hand — which is the
answer to retail's 106 KB — and the next value is validated before it becomes the
committed one. The `after` hook runs on the returned value before the commit, and
a mutator that throws now commits NOTHING, which is strictly better than the draft
version's half-applied clone.

### `get` returns a readonly snapshot, and that is a compile error at ~10 sites

The retail hazard changes shape rather than disappearing, and this is the part to
get right. `retailTool` (`retail/store.ts:200`) passes only `ctx` to its inner
body, which re-reads with `retailSlot.get(ctx)` (`cancel_pending_order.ts:31` and
~10 siblings) and then mutates what it got. Under a replace, that mutation is
simply lost — no throw, no log, landing in the agent tau2 measures.

So `get` returns `DeepReadonly<T>`. Every one of those bodies becomes a COMPILE
ERROR naming the file, which is the shape this repo already reaches for when an
authoring mistake has to be unrepresentable (`InlineToolsMisuse`,
`PipelineOnlyMisuse`) — and it is a strictly better outcome than the draft's
answer, which was to make the silent case work by threading identity through the
slot.

Note eve does NOT have this: its `get()` hands back the live value out of the map,
so in-place mutation there is invisible but not lost — the step boundary
serializes whatever the map holds. Our commit is per mutation, so we need the type
to say what eve's architecture makes moot.

**Template rewrite, stated rather than buried.** The five shared in-place helpers
(`pushCapped`, `pruneState`, `recalculateAlertLevel`, `createIncident`, `note`)
become functional, the two mutating `after` hooks
(`travel-concierge/shared.ts:315`, `dispatch-center/shared.ts:201`) return a value
instead of mutating one, and the ~31 mutation sites are rewritten. That is exactly
the churn the first draft existed to avoid, and it is now the point: every one of
those sites is a place where in-place mutation of session state was invisible to
anything that might store it.

### `ctx.state` is REMOVED, and slots own their storage

Raw `ctx.state` is the remaining unobservable write path, and while it exists at
all the one true path has a bypass by construction. A read-only view was the
first draft; it is a compatibility shim for callers that read the bag, and
**there are none** — every `ctx.state` mention in template code is a comment.
So the bag goes, and a slot stores its value in the store directly, keyed by
`(sessionId, slot key)` rather than as a property of an object that is itself
stored.

This is the largest deletion in the plan, and all of it is unlocked by not
preserving the API:

- **`ToolContext.state` and its `any`.** The field is typed `any` deliberately,
  documented as such because "session state is a genuinely dynamic bag created by
  the agent's `state` factory" — a bare `any` in a public signature whose whole
  justification is the bag. Remove the bag, remove the `any`. Slot values are
  typed by their own `sessionSlot<T>`, which is stronger than the annotation
  authors were told to write.
- **`ToolContext<S>`'s generic, and `AgentStateOf`.** With no bag there is no
  per-agent state shape to thread, so `tool()` stops needing an annotated context
  to type state at all.
- **`AgentDef.state` and its `NoInfer` machinery.** The factory exists to create
  the bag and to be "the ONLY thing `S` is inferred from"; `slot.state` exists
  only to feed it. Both go. That also retires the documented trap that four of
  five slot-backed templates forgot to declare it — an omission that becomes
  unrepresentable.
- **`SlotState` / `SlotStateOf`.** Pure type machinery for locating a value
  inside the bag.
- **`getState` (`host/runtime-tools.ts:253`)** and the `?? {}`-vs-memoization bug
  its doc comment describes at length.
- **`guard-invariants` rule 6** (`ctx.state as T` in a template) — the pattern
  becomes unrepresentable, so the rule retires and its number is retained per the
  stable-ID rule.

Two things this forces a decision on rather than deferring:

- **`agent({ syncState })` projects the whole bag**, so with no bag the
  projection belongs to the slot. `slot.projection` already exists and the
  templates already use it (12 sites); this makes it the only spelling, and the
  client-visible `agent_state` frame carries the merge of every slot's
  projection.
- **`_state-sync.ts` keys `lastSent` in a `WeakMap` by the state OBJECT.** With
  per-slot values there is no single object to key on, so the unchanged-check
  moves to per-slot — which is the finer granularity anyway, and avoids the
  `agent_state`-flood bug `runtime-tools.ts` documents rather than preserving the
  mechanism that guards it.

## Reads: hydrate inside `session.start()`

`getState(sid)` (`host/runtime-tools.ts:253`) is the sole memoization point and
is **synchronous**; every caller assumes that. So state cannot be loaded lazily
on first tool call — and there is an existing seam that fits exactly.

`host/ws-handler.ts:331-344` sends `config` **synchronously at zero RTT**,
*before* calling `session.start()`. `start()` then runs async, bounded by
`DEFAULT_SESSION_START_TIMEOUT_MS` (10s), with inbound client audio buffered
until it resolves (`drainBuffer()`, line 359). Hydration belongs inside that
window: after `config` — so the client's handshake guard, which treats a socket
carrying nothing as an unhealthy peer rather than a slow one, is unaffected — and
before the session is ready, so no tool can observe unhydrated state. The
existing failure path already tears the session down and tells the client
(`failClientAndClose`), so a hydration that throws or exceeds the budget needs no
new error handling.

Two properties follow. It is paid **only on a resume**, since a fresh session has
nothing to load. And it does **not** conflict with `pushStateSnapshot`'s
deliberate avoidance of calling `getState` at connect time (which exists so the
agent's `state()` factory does not run early) — the two sit at different points
in the connect sequence rather than competing for one.

**Reclamation is one path over the store.** The 120s `SESSION_RESUME_GRACE_MS`
sweep (`host/session-state-sweeps.ts`) currently deletes from the `Map`; it
becomes a sweep over the store. The Postgres backend additionally needs a TTL
sweep for rows whose guest died without a grace window ever elapsing — that is
one sweep with two triggers, not a second mechanism.

## Cost on a voice session

A voice agent is the target, not an exception — what the eve section rules out is
checkpointing every *turn*, not persisting state. None of the cost lands on the
audio path:

- **The audio path is untouched.** Nothing is written per audio frame, and
  nothing between an STT final and TTS output except inside a tool call. The
  500ms barge-in budget and the ~1.0s time-to-first-token are unaffected.
- **A commit extends a tool call by roughly one query.** Tool turns already
  average ~6.2s (EVA airline run) and chains run 15-24s (tau2 retail), against a
  `deadAirCoverMs` of 5000. It must be AWAITED: fire-and-forget would drop
  exactly the writes a crash is supposed to preserve.
- **A hydration read is paid once, on resume only.**

**The size case to watch is retail: ~106 KB of state** (`seed.json` is 108,893
bytes) mutated on nearly every tool call. A naive commit writes all of it every
time. The draft model makes the remedy cheap — the commit holds both the previous
value and the draft, so writing only on actual change is a comparison whose
inputs are already in hand.

## What the PLATFORM owes this, which the sections above understate

Read against `aai-server`, this plan is mostly invisible to the platform — which
is by design: the platform holds no session and no agent config, so nothing here
reaches it through the SDK. What it does reach is the app DATABASE, and that is
`aai-server`'s. Two corrections and three decisions follow.

**The TTL sweep cannot live in the guest.** The scope table puts reclamation in
`host/session-state-sweeps.ts`, which is right for the grace sweep and wrong for
the case that motivates a TTL at all: those rows belong to a guest that is GONE,
and an agent guest self-exits on idle. That is the gap that produced
`workflow-wake.ts` verbatim — "a durable run outlives the call that started it,
and on the platform the SANDBOX does not." So reclamation is two mechanisms
after all: the grace sweep in-process, and a PLATFORM sweep for whatever a dead
guest left behind, as a `platformCronJobs()` entry in `aai-server/pg-cron.ts`.
One constraint that file already records — "an `APP_DB_URLS` cluster has no local
schema/role, so the drops no-op there" — means a cron-only sweep silently
reclaims nothing for apps placed off the platform database.

**The DDL question is already answered, by precedent.**
`host/workflow-wake-hint.ts` creates its table with `create table if not exists`
in the tenant's own schema, because "there is no provisioning pass to hang a DDL
step off — an agent's first workflow may be its first ever deploy." A state table
is in exactly that position, so it takes the same route with the same posture:
tenant-owned, tenant-writable, therefore never authority for anything the
platform decides.

**Which suggests this store should SUBSUME the wake hint.**
`_workflow-wake-read.ts` is already a cross-tenant reader over app schemas with
three hazards solved and written down: a transaction-scoped leader lock, `set
local` for the statement timeout, and a SAVEPOINT per tenant so one broken
schema cannot deny every later tenant its read. A second guest-written table in
the same schemas either reuses that or re-derives it, and the argument for one
store with two backends applies a level up — two per-app tables with two readers
is the duplication this series exists to remove.

**Durability lands OPT-IN, and this plan reads as though it does not.**
`provisionAppDatabase` has exactly one caller, the storage-enable route
(`storage-handler.ts:67`, cited above for the deprovision hazard), so
`DATABASE_URL` is absent for every agent nobody toggled storage on and those get
the memory backend — today's behaviour, with today's silent loss. "Reliable
across crashes" therefore describes a SUBSET of deployed agents. The two ways out
want deciding here rather than during implementation: provision on DEPLOY, which
reaches the deploy path, the platform connection budget, the orphan-preview sweep
and `delete.ts` — and would let the whole toggle surface collapse, since every
app would have one — or keep two durability tiers and make which tier an agent is
in something an author can see.

**Two numbers to check before committing to a write per mutation.**
`APP_DB_CONNECTION_LIMIT` is 4 per app role (`app-database.ts:47`) and one guest
serves many concurrent sessions, so an awaited commit per mutating tool call
contends for four connections already shared with `ctx.db` and the workflow
queue. And `statement_timeout` is `USERSET` — `aai-server/CLAUDE.md`'s "never
treat the role setting as isolation" — so the 10s setting is not what bounds a
commit.

**What it gives the platform back, and this is the strongest argument for doing
it.** Two platform paths hand a reconnecting caller a DIFFERENT guest by design:
`handoverSlot`'s blue-green redeploy, and the fleet-wide peer route a cold broker
takes when another replica is already serving the deploy. Both land the caller on
a process whose state map is empty, so the loss this plan opens with is not only
crash-and-redeploy — it is the routine behaviour of two mechanisms, recorded in
neither package's guide. This is what makes them correct, and it removes the
unstated barrier to reintroducing per-slug horizontal scaling
(`sandbox-scale.ts`, in git history), where two live guests for one slug would
today diverge on `ctx.state`.

**One cost lands in the product, not in the platform.** `appDatabaseUsage` counts
every base table in the app schema and the studio shows that as the USER's own
database usage, so retail's ~106 KB of session state becomes tables, rows and
bytes an author reads as their data. An argument for the size cap in Open
questions, and for naming these tables so their owner is obvious.

## Failure modes

**Shape drift on redeploy is the hard case, and it is specific to redeploy.** A
crash brings back the same code; a redeploy brings back *new* code, and a
redeploy is exactly when a slot's shape is most likely to have changed. So the
value was written by the previous version of the agent and read by the next one,
mid-call, for live callers.

The answer must be **fail-open**: on a shape or key mismatch, or any hydration
failure, discard the stored value, fall back to `create()`, and log loudly.
Refusing the session would mean a routine deploy drops every in-flight call — an
outage in exchange for avoiding a forgotten cart. This is eve's `serialize.ts`
rule.

So: **persistence is reliable across crashes and best-effort across redeploys.**
Anything stronger needs versioned slot schemas with author-written migrations,
which is a much larger feature.

**The marker is structural, and a slot declares no `version`.** The alternative
was an author-supplied version number, whose only real argument was that it is
the input a future migration story would need — i.e. an argument about
compatibility, which this series is not buying. A structural marker needs nothing
from the author and cannot be forgotten, and under fail-open a wrong guess costs
one session's state rather than correctness. If migrations are ever wanted, they
arrive as a breaking change to the slot API like everything else here.

## Scope

| Change | Where |
| --- | --- |
| Store interface + memory backend (replacing `stateMap`) + Postgres backend | new module(s) in `host/`, on `createPostgresDb` |
| Backend selection by `DATABASE_URL`, mirroring `configureWorkflowWorld` | `host/runtime.ts` |
| Synchronous functional `update(fn)`; `get` returns `DeepReadonly<T>`; validate-at-`set`; per-slot durable/virtual declaration | `sdk/session-slot.ts` (410 lines — near the 500 cap, likely needs a split) |
| Rewrite the 5 in-place helpers as functional, the 2 mutating `after` hooks, and the ~31 mutation sites | 8 templates |
| **Remove** `ctx.state`, `ToolContext<S>`'s generic, `AgentDef.state`, `AgentStateOf`, `SlotState`/`SlotStateOf`, `getState` | `sdk/types.ts`, `sdk/define.ts`, `sdk/session-slot.ts`, `host/runtime-tools.ts` |
| Move `syncState` projection onto the slot; per-slot unchanged-check | `sdk/define.ts`, `host/_state-sync.ts` |
| Retire `guard-invariants` rule 6 (number retained) | `scripts/guard-invariants-rules.mjs` |
| Hydrate inside `session.start()` | `host/ws-handler.ts`, `host/runtime-tools.ts` |
| Grace sweep over the store | `host/session-state-sweeps.ts` |
| TTL sweep for rows whose guest is gone — a PLATFORM job (see above) | `aai-server/pg-cron.ts` |
| Retire `guard-invariants` rule 6's baseline entries; give back the `as unknown as` hatches in `retail/store.ts` and the three retail specs | `scripts/escape-hatch-baseline.json` |
| Epoch bump for `aai:state` as `--drop` (see below), api-report, changeset `major` | `contracts/`, `.changeset/` |

**Every epoch here is `--drop`, not `--retain`.** The contract mechanism exists
to CLASSIFY a break, not to prevent one, and a retained epoch obliges a frozen
example that still compiles — which is a compatibility promise this plan is
deliberately not making. So each affected capability is
`node scripts/api-contracts.mjs --bump aai:state --drop "<reason>"`, which also
deletes the frozen example rather than leaving a file that cannot compile. Same
for the other plans in this series.

**Template migration is REAL work, and that is the accepted trade** (see "Writes
are a functional replace"). The audit found no slot state holding a non-JSON value
— every `Map`/`Set` is a module-scope constant, `Date.now()` is a number — so all
eight templates are already storable, and the migration is mechanical rather than
uncertain: the ~31 mutation sites become replaces, and the ~30 `slot.get` sites
are each either a pure read (unchanged) or a mutation the new `DeepReadonly<T>`
return type turns into a compile error naming the file. Nothing has to be found
by inspection, which is the property the draft model could not offer.

## Open questions

- **Does a stored value need its own size cap?** `_state-sync.ts` already caps
  the `syncState` projection crossing the wire, and retail sits at ~106 KB of
  state; the two limits answer to different budgets and should probably not share
  a number.
- ~~**Does the memory backend clone on commit too?**~~ **Moot with the replace:**
  nothing clones. What must still hold in BOTH backends is the serializability
  CHECK at `set`, for the reason that question had — skipping it in memory lets
  a template hold a `Map` that only fails once storage is enabled, the two-path
  failure the single store exists to prevent.
- **Does `get` freeze at runtime as well as in the type?** `DeepReadonly<T>` is
  free and catches every typed call site, and it reaches no untyped user project.
  A deep freeze would, at the cost of a walk per READ where the draft model paid
  a clone per write — and retail reads far more often than it writes, so this is
  not obviously the cheaper end. A middle option worth pricing: freeze only the
  top level, one call, which still catches the common `state.field = x`.
- **Is a synchronous mutator sufficient for every template?** The audit needs to
  confirm each of the ~31 sites can move its awaits in front of the replace. One
  is already known to be interesting: `dispatch-center`'s `after` hook prunes and
  recalculates, so it must stay pure and synchronous too.
