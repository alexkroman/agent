# Dialogs, wired to a session

Reference for `runtime-dialogs.ts`, `runtime-dialog-knobs.ts` and
`transports/pipeline-dialog-knobs.ts` — the runtime half of `dialog()`. A
SIBLING of the package guide rather than a section of it, per the root
`AGENTS.md`: this is read once you are already changing the dialog bridge, and
none of it is needed to work elsewhere in the package. `packages/aai/CLAUDE.md`
owns the authoring half; `sdk/dialog.ts` owns the gate.

## What declaring a dialog on the agent buys

`agent({ dialogs })` is a host-only field, and it is what WIRES a dialog rather
than a formality. Everything `dialog()` promises beyond the tool gate happens
when no tool is running, which is why none of it could work from inside one:

| Promise | Where | Reaches |
| --- | --- | --- |
| session events move it (`@`-prefixed transitions) | `SessionDialogs.observe`, called by `session-emitter.ts` | every transport |
| the active instruction reaches the model on EVERY turn | `SessionSystemPrompt.setSuffix` | pipeline, OpenAI Realtime (see the package guide's per-turn prompt table) |
| a per-state `timeout` is armed and fired | `createRestartableTimer` per dialog | every transport |
| `bargeIn` / `toolChoice` / `temperature` per state | `PipelineTransportOptions.dialogTurn` | **pipeline only** |
| `voice` / `keyterms` per state | nothing | **nothing — warned at the first session** |

An UNDECLARED dialog is unchanged: its tool gate, `send`, `position` and
`projection` all work exactly as they did, and an author can still drive one by
hand from an `events` handler (`claim.receive(ctx, e)` — a `SessionEventContext`
IS a `SlotHolder`).

## The four decisions

### The bridge runs BEFORE the agent's `events` hooks

The emitter's order is record → send → **dialogs** → hooks → commit. A dialog is
part of the session's STATE; a hook is an observer of what the session did, and
by the time an observer runs everything the event caused should already have
happened. So a `"session.timed-out"` handler reading `claim.position(ctx)` sees
the state the dialog moved TO — the state it declared a transition to precisely
in order to handle that event. The other order hands that handler the state the
call has just left, silently, with nothing in the handler to tell.

Nothing wants the other order: no part of the runtime reads a hook's result, and
a hook that drives the dialog by hand is idempotent against the bridge (the
machine has taken the transition, and the same event offered again finds nothing
that handles it).

### Two dialogs concatenate in DECLARATION order

One suffix section, one line per dialog whose active state declares an
`instruction`, in the order `agent({ dialogs })` lists them. Declaration order is
the only order an author wrote down and can see; sorting by key would be
arbitrary, and "last dialog wins" would silently drop the instruction of every
dialog but one, which is the opposite of what declaring two of them asks for. A
state with nothing to say contributes NOTHING — not a blank line, not a
placeholder — and when no dialog contributes, the suffix is `""` and
`SessionSystemPrompt.resolve()` hands back the base string ITSELF.

The VOICE KNOBS merge on a different rule, per KEY with the last declaration
winning, and the asymmetry is not an oversight. Inside one dialog the states are
NESTED, so a phase that pins a voice and a barge-in together means them together
and `toVoiceConfig` is deepest-DECLARATION for that reason. Two dialogs have no
containment relation — neither is a special case of the other — so there is no
"together" to preserve and per-key is the only merge with a meaning. Last writer
wins is what `composePrepareStep` already does one layer down.

### The deadline clock runs from the dialog's last MOVE

Armed on state entry, re-armed every time the dialog MOVES — including a SELF
transition, which is a move even though the state path is unchanged — and
extended by nothing else. Both shapes a voice call wants are then expressible,
with the runtime guessing nothing:

- **A silence ladder** wants "since we last heard anything". Declare the hearing:
  `on: { "@user-transcript.committed": "listening" }` on the state itself is a
  self transition, so every committed utterance restarts the window and only real
  silence reaches the deadline.
- **An abandonment or escalation deadline** wants wall clock from entry — "still
  verifying after three minutes". Declare no transition on the chatter and the
  window is never extended by it.

A runtime rule instead ("reset on any user speech") would have made the second
unexpressible on any caller who talks, and would have given one written
declaration two meanings depending on which events happened to arrive. The author
names the events that count, which is what `@`-prefixed transitions already are.

**A move is detected by a WRITE, not by a position comparison.** `Dialog.receive`
writes the slot when — and only when — the active state handled the event, and it
returns the position either way, so comparing positions cannot see a self
transition. The bridge therefore offers events through a write-counting
`SlotStore`, the same instrument `session-emitter.ts` uses on a hook's context and
for the same reason: the commit is what a move costs, and almost every session
event reaches a dialog that declares no transition on it.

**The armed STATE is recorded with the deadline**, because a gated tool can move
the dialog without the bridge seeing it (a tool writes through the executor's own
slot view). At fire time the position is re-read: a mismatch re-arms from where
the dialog actually is instead of firing a transition the conversation has left.

### Three of the five voice knobs are live; two are impossible

`transports/pipeline-dialog-knobs.ts` carries the table. The short version:

- **`bargeIn`** — live. The two interim gates in `pipeline-user-speech.ts` are
  read at the moment a partial is classified, so they became thunks.
  `bargeIn: "off"` is `minBargeInWords: Infinity`: both gates are
  `words >= threshold` tests, so an unreachable threshold is exactly "the agent
  finishes its sentence". The word COUNT is still computed, so a caller talking
  over a disclosure is still transcribed, still opens the speaking edge, and is
  still answered once the reply ends.
- **`toolChoice` / `temperature`** — live, and **per STEP** rather than per turn.
  They arrive as a `prepareStep` preparer composed before `forceFinalAnswer`,
  which is the stronger place: a gated tool can move the dialog in the MIDDLE of
  a turn, so the step after it already runs under the next state's knobs. And
  `forceFinalAnswer` keeps its override of `toolChoice` on the reserved answering
  step, so a state pinning a tool cannot un-reserve the one step that exists so
  the model has no move left but to speak.
- **`voice`** — impossible. `TtsOpenOptions` carries no voice: it is baked into
  the DESCRIPTOR that produced the opener, and the open happens once per session.
  Changing it mid-call means closing the socket and dialling a new one, which is
  a gap in the agent's own sentence.
- **`keyterms`** — impossible. `SttOpenOptions` has no keyterms field at all.
  Only the AssemblyAI S2S service takes them, in its opening `session.update`.

Both impossible ones are WARNED rather than dropped, naming the dialog, the state
and what to use instead (`agent({ voice })`, `agent({ sttPrompt })`) — a knob that
silently does nothing is worse than one that is absent, and "the TTS voice
changes mid-disclosure" is exactly the claim a reader would believe on finding
the field accepted.

**It warns rather than throws, and the choice is about WHEN it runs.** `dialog()`
refuses at declaration the defects it can see for itself (an `after` no dialog can
fire, a `when` naming no state). This one cannot live there: whether `voice` can
take effect is a property of the TRANSPORT, which the SDK does not know. The
earliest moment it can run is the first session — a caller already on the line —
and hanging up on them over a knob that merely does nothing is the worse outcome.
Reported once per agent definition (a `WeakSet` keyed on the `agent.dialogs`
array), at warn level.

**The transport half of the same warning is in `runtime-transport.ts`.** Neither
S2S branch applies any of the three live knobs — those services assemble each
request and own turn-taking — so `warnDialogKnobsUnavailable` says so when a
session takes one of those branches with knobs declared.

## Mechanics worth not rediscovering

- **The dialogs are PRIMED on the first session event, not when they are bound.**
  A resume hydrates the slot store inside `core.start()`, which runs after
  `createSession` returns. Reading a dialog before that stores the machine's fresh
  initial snapshot over a position the caller had already reached, and the call
  resumes at the top of a script it was halfway through. By the first event
  (`session.configured` at the handshake) the hydrate has landed.
- **A transition's own commit does not re-enter the dialogs.** A move writes a
  slot, a write needs a commit, and a commit emits `state.updated` — a session
  event a dialog may declare a transition on. The whole settle runs under a latch;
  an event emitted while it is held is recorded and sent to the client like any
  other and offered to no dialog. Same shape and same argument as the emitter's
  `announcing` guard one layer up. Both `runtime-dialogs.test.ts` and
  `session-emitter.test.ts` A/B it.
- **`refreshSystemPrompt` is called only when the rendered suffix CHANGED.** The
  suffix thunk itself always renders fresh, so pipeline mode is correct with no
  push at all; the push exists for a service holding its instructions as session
  state (OpenAI Realtime), where it is a `session.update` frame and the VAD state
  behind it. A move that changes no words pushes nothing.
- **A move the bridge cannot see leaves the pushed prompt stale until the next
  one.** A gated tool's transition is that move — but it is also the one case the
  model already learns about, because `DialogToolResult` carries the position into
  the tool result on exactly the turn it moved. Pipeline mode is unaffected either
  way.
- **Preemptive generation is turned OFF for a session whose dialogs vary the LLM
  knobs.** The speculation decides once, from the SESSION's `toolChoice`, whether
  speculating is free at all, so a state that pins a tool would make every
  speculation end at the tool boundary with the gate still believing it was free.
  Conservative in one direction on purpose: a dialog declaring only `bargeIn`
  turns it off too, and preemptive generation ships off by default.
- **A throwing dialog is contained PER DIALOG**, exactly as the emitter's two
  hook slots are — they are independent declarations, and this runs from transport
  event dispatch with nothing above it to catch a throw.
- **Deadlines are disarmed when the session stops** (`SessionDialogs.stop`, called
  from `attachSessionState`'s release). A pending `setTimeout` keeps the event loop
  alive and would fire into a session whose slot cache has been swept.

## Not done

- **`voice` and `keyterms` on the AssemblyAI S2S transport.** That service takes
  both in `session.update` and the handle already exposes the verb, so the knobs
  are reachable there in a way they are not on the pipeline. Wiring them means
  deciding what a mid-call `session.update` costs (the service re-derives VAD
  state, the same reason `refreshSystemPrompt` is change-gated) and moving them
  out of `INERT_KNOBS` for that branch only — which is a transport-aware check,
  where today's is transport-blind.
- **A dialog's deadline does not survive a process restart.** It is a
  `setTimeout` in this process; a session that resumes onto a replacement process
  re-arms from the state it hydrates into, with the elapsed window lost. Making it
  durable means a wake hint beside the workflow one, which is its own change.
