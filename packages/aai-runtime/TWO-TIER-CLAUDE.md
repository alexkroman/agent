# TWO-TIER-CLAUDE.md — the fast/slow split

A SIBLING of `packages/aai-runtime/CLAUDE.md` rather than a section of it, for
the reason `JOURNAL-CLAUDE.md` is one: this is REFERENCE, read once you are
already changing the bridge, and none of it is needed to work elsewhere. The
one RULE an editor of this package has to carry around — a session may install
more than one prompt SUFFIX, and the slot is keyed — is in `CLAUDE.md`.

`packages/aai/src/sdk/two-tier.ts` owns the authoring half and the sources.

## What it is

`agent({ twoTier })` puts a second model behind the first. The fast tier is the
agent's own `llm`, holding the call; the slow tier owns every tool. It is OFF
unless declared, and `createTwoTierWiring` answering `undefined` is the whole
off-switch.

The shape is Pine AI's TalkAct (19PINE-AI/TalkAct), whose measurement is p50
**0.63s** voice latency against **10.89s** for one model doing both jobs, at 8/8
task success either way. Read their `ARCHITECTURE.md`, `REPORT.md` and
`src/cuv/{shared,fast_agent,slow_agent}.py` before changing the contract; the
`state_summary`-on-every-action mechanism is in `slow_agent.py`'s `_tool()`.

## Eight modules, and what each one owns

| Module | Owns |
| --- | --- |
| `two-tier/resolve.ts` | every default, in one place. `undefined` in, `undefined` out |
| `two-tier/digest.ts` | the record: `revision`, `summary`, the work entries. No model, no clock, no network |
| `two-tier/digest-prompt.ts` | rendering it as a prompt SECTION, and the cap's trim order |
| `two-tier/view.ts` | the INFORMATION BOUNDARY — `SlowTierView`, branded, and `SessionFacts` as the only way to widen it |
| `two-tier/prompt.ts` | both tiers' instructions, and the LITMUS TEST above them |
| `two-tier/channel.ts` | the `state_summary` argument, the three channel tools, the completion refusal |
| `two-tier/gate.ts` | one call's decision: strip, channel, refuse, track |
| `two-tier/slow-loop.ts` | the detached `ToolLoopAgent`, its model, and the effort hint |
| `two-tier/session.ts` | one session's wiring: the conversation, the wake, the coalescing runner |
| `two-tier/wire.ts` | the one door from the runtime, called by `setupTools` |

## The five decisions worth not relitigating

### 1. Nothing the caller waits for is downstream of the slow tier

It runs OUTSIDE every turn. The brief's requirement was "fail open on
slow-tier timeout"; what is built is stronger and simpler — there is no branch
in which a hung second model makes the caller wait, because the caller's turn
never awaited it. So `twoTier` carries no fail-open/fail-closed policy knob:
failing open is what the architecture DOES, and a setting for it would be a
setting with nothing to set.

`timeoutMs` still bounds a RUN, so a wedged provider does not hold the run slot
forever. What a timeout costs is a stale digest, and the fast tier keeps
talking.

### 2. The fast tier has NO tools, and that is the mutation gate

`tiers.fastToolSchemas` is `[]`, so the request carries no tool list at all —
`pipeline-llm-stream.ts` omits the key rather than sending an empty one, which
several small models refuse outright (`400 … does not support tools`). The
"only the slow tier may mutate" property is therefore a property of the
request, not of anyone's care.

`tiers.fastHasTools` is `false` for the same reason and is easy to forget: the
base prompt's tool guidance would otherwise describe a surface the fast tier
does not have, which is how a tool-free model comes to narrate calls it cannot
make. Both answers come back from one function so that honouring one and
forgetting the other is not possible.

### 3. The digest is written by the SLOW tier and read by the FAST one

Never the reverse. The fast tier's own belief about the state of the work is
what hallucinated completion is made of; a digest it could write into would
launder that belief into something the next turn reads as fact.

It reaches the fast tier through `SessionSystemPrompt.setSuffix`, which is the
seam `dialog()` already uses and for the same argument, stated there: "the only
way a phase reaches the model today is a tool RESULT, so on a turn where no
tool ran, the agent answers with no idea where in the script it is." Replace
"phase" with "whether the work is finished" and that sentence IS the failure.
**The slot is KEYED now** — it was last-writer-wins, and the two-tier install
silently deleted the dialogs'.

An empty digest renders `""`, so `resolve()` hands back the base prompt itself
and an agent before its first tool call sends the bytes it always sent.

### 4. Neither channel is new

- **slow → fast** is `Transport.injectTurn`, handed an INSTRUCTION rather than
  the words: the fast tier says it in the register the rest of the call is in.
- **fast → slow** is `user-transcript.committed`. The runtime hears the caller
  directly, so the relay is unconditional and the fast tier is asked for no
  protocol at all — where TalkAct's fast agent must emit `@slow:` or the
  information never arrives (their ablation: **0/4** without it) and their
  parser carries three regexes to strip the scaffolding small models echo into
  speech instead.

`createCoalescingRunner` is `interrupt_event`: three utterances during one slow
step produce ONE follow-up, over the latest conversation.

### 5. Completion is gated MECHANICALLY, and only on what is in flight

A `completes` tool is refused while `digest.unsettled()` is non-empty — checked
before any entry is opened, so a refused hand-off does not itself become
outstanding work. The refusal is a returned `ToolFailure` (per
`TOOL-OUTCOMES-CLAUDE.md`, the channel for "the model can recover"), so the run
finishes the work and reports again rather than the turn ending.

**`pending` is the only non-terminal state, and that is deliberate.** A REFUSED
or FAILED entry is settled: blocking completion forever on one would wedge a
call with no way out, so the judgement about a refusal is the slow tier's,
which sees it in the brief. Every tracked call settles on EVERY exit — that is
what keeps an abandoned run from leaving an entry pending forever.

## What it does NOT reach, stated because the difference matters

**The fast tier SAYING a false completion.** Speech is not a tool call. What
the gate prevents is the CALL; what grounds the speech is the rendered
statement of outstanding work on every request. An agent that wants a hard stop
writes an `outputGuardrails` entry — the one seam that can refuse a sentence.

**An agent whose `systemPrompt` is a RESOLVER.** The slow tier is handed
`SystemPromptResolver.base()`, which carries the static half only (the resolved
prompt already contains the digest section, so the slow tier would read its own
last summary back as instructions). Same limitation `S2sSessionConfig.systemPrompt`
records for its own reason.

**S2S.** Refused at config time with every other `AgentModelTuning` field: the
provider owns the loop and calls the tool itself, so there is no moment between
the proposal and the mutation for a second tier to stand in.

## The information boundary, and why it is a TYPE

The claim a fast/slow gate makes is that its gain comes from additional
REASONING over agent-visible inputs. A slow tier that can see the task
definition, the expected actions, the grading criteria or a simulated caller's
hidden profile is an ORACLE — it scores well, ships nothing, and the failure is
silent. Under a benchmark the task objects are in the same process, so this is
concrete rather than theoretical.

`SlowTierView` carries a `declare const … unique symbol` brand, so there is no
value to write and an object literal is a compile error. `slowTierViewOf` is
the only producer and takes `SessionFacts`, whose three members are exactly
what the fast tier has. The digest is not a parameter — it is read off the
session's store. **Widening what the slow tier sees means editing
`SessionFacts`**, which is one reviewable place with the argument above it.

The prose half is `prompt.ts`'s litmus test, which a type cannot reach: *could
this sentence appear in a real call-center training manual written before its
author ever saw a benchmark?* Apply it to the whole text on a fresh read, never
only the diff. Pickle removed their own static keyword check and recorded why —
prompt meaning is wording-sensitive and a passing blacklist creates false
confidence; their full-prompt review found benchmark-shaped content in a prompt
the test had accepted.

## Testing it does not mean running a model

`openTwoTierSession` takes the slow loop as a SEAM (`slowLoop: (session) =>
SlowLoop`), so `session.integration.test.ts` drives the whole bridge — the
digest, the gate, the channel, the wake, the runner — with a function. The unit
tier covers the digest, its rendering, the channel vocabulary, the view's
trimming and the config defaults, none of which touches a clock.

Two things the specs caught that are worth keeping covered: the framework's own
channel tools tripping the "no `mutates` declaration" warning (a warning about
the framework teaches a reader to stop reading the log), and `slice(-0)` being
the whole list, which would silently widen the context window to everything.

**And one thing writing them found about this PACKAGE's tier selection.**
`test:integration` here read `src/integration/**/*.integration.test.ts`, a
DIRECTORY, where the root `AGENTS.md` says tier membership is a naming
convention — so `two-tier/session.integration.test.ts` was collected by
nothing and reported as nothing. It is `src/**/*.integration.test.ts` now. The
trap is the one a silent skip always is: the file passed every gate, including
`check:module-tests`, while never running in the tier that selects it. A
co-located integration spec anywhere else in this package would have had the
same fate.
