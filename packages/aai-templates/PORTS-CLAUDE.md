<!-- A SIBLING of packages/aai-templates/CLAUDE.md, read on demand: the guide is
at its 120,000-character cap, and these are reference accounts for someone
already inside one of the ported templates. The table that says which template
ports what stays in CLAUDE.md, under "Six templates are ports of
LangChain/LangGraph agents". -->

# The LangChain/LangGraph ports — what each one kept, and what it changed

Each port carries its attribution and a their-name → our-name table in the
module that holds the prompts (`prompts.ts`, or `shared.ts` where there is no
prompts module), so nothing here has to be re-derived from memory. What follows
is the account per template: the mechanism worth reading it for, and the
decisions that were measured rather than preferred.

**`travel-concierge` — the two mechanisms, and the narrowing that is enforced
now.** Their graph gives each specialist node its own bound tool set and swaps
the assistant's prompt as `dialog_state` is pushed and popped. A voice session
has ONE model with ONE tool list and a system prompt fixed at connect, so the
stack is real state (`routing.ts`, projected to the sidebar) and the
specialist's brief arrives as the delegation tool's return value.

**This guide used to call the narrowing "asked for rather than enforced". Its own
eval disproved the ask — 0 of 5 live runs delegated.** So it is a mechanism:
`requireDesk` (`shared.ts`) gates all nine desk tools on the dialog stack and
answers a `ToolFailure` naming the `to_…_assistant` to call. 7 of 7 after. The
gate then exposed two prompt defects a wording fix would have hidden, both in
`packages/aai-runtime/CLAUDE.md`'s eval section.

The half that IS enforced is the confirmation gate, and it is the bit worth
copying into any agent that can spend someone's money. Every sensitive tool
STAGES a `PendingAction` and mutates nothing; `confirm_action` is the only code
path that applies one. That is `interrupt_before` with a better interface —
a caller cannot type "y", but asking out loud and hearing "yes" is the same
gate — and it is the reason `stageAction` is one helper rather than a pattern
each tool repeats: the next sensitive tool is otherwise the one that forgets.
Its spec asserts, per tool, that calling it changes nothing.

**`support-line` — the graders are the product.** Retrieval is idf-weighted term
overlap over `knowledge.json`, not embeddings, because the SDK has no vector
store; the argument in `shared.ts` is that this makes CRAG's corrective loop MORE
valuable rather than less, since a weaker retriever is exactly what its query
rewriter was designed for. The knowledge base is BAITED to prove it — "cancelling
your contract" and "cancelling an engineer visit" are two documents, two fees and
one word apart, and a spec pins that the neighbour ranks FIRST for a caller's
phrasing. Three decisions in the loop are not defaults:

- **An ungrounded answer is never spoken.** One regeneration, then the answer is
  withheld and the run ends `exhausted`. A grounded-but-not-useful answer, by
  contrast, IS returned, with its verdict, because it is still true.
- **`exhausted` is a reachable state with somewhere to go** — `log_ticket`. An
  agent that cannot say "I don't have that documented" will eventually say
  something worse, so the exit has to exist before the grading is worth anything.
- **There is no web-search fallback**, which CRAG has. A support line answering
  from the open web about a private product is the exact failure its grader
  exists to prevent; `plan-and-execute` is where real search lives.

**`plan-and-execute` — the loop belongs to the caller.** Their notebook runs
plan→execute→replan to completion and prints the answer. A phone line cannot go
quiet for ninety seconds, so one `work_next_step` call is exactly one
execute-then-replan turn: the desk reports, and the pause that creates is what
makes `revise_plan` reachable at all — a replanner driven by the person rather
than by a step result, which their version has no way to express. Two more
things are decisions:

- **`Act = Union[Response, Plan]` became one discriminated object.** A union is
  `anyOf` in JSON Schema and provider support for it varies; a model that emits
  `{"steps": …}` when it meant to respond leaves a plan looping forever.
  `normalizeAct` then treats every malformed act as an ANSWER, because a desk
  that never stops is the failure that matters on a call.
- **The search is real and therefore injected.** `executeStep` takes a
  `SearchFn`; the tool passes `liveSearch` (`webSearch`, DuckDuckGo-backed, no
  key) and the spec passes its own. A template spec that depended on the live web
  would be a flake with a stranger's rate limit attached.

**`redline` — a loop whose exit is data, and the mixed form.** Two things in it
are worth reading for, and neither exists elsewhere in `templates/`:

- **The `while` is legal because the verdict is journaled.** `transcription-workflow`
  derives its fan-out's WIDTH from a step's result; this derives a LOOP EXIT from
  one. `critiqueDraft` returns `ship` or `revise`, the body breaks on it, and a
  replay reads that verdict back out of the journal and takes the same branch —
  where a clock, a random draw or a re-read of anything outside the run lets a
  replay take a DIFFERENT branch, which nothing detects: a step call that lands
  in a different position simply reads the entry that position holds. Their
  `should_continue` stops
  on a message COUNT, which spends the same money on a draft that was already
  good; letting the critic stop the loop is the one real addition, and it is
  possible only because the decision is a step result.
- **Its page is the MIXED form**, which the guide has described for a while with
  no template behind it. `<WorkflowFields>` renders the three scalars (the
  `z.enum` becoming a `<SelectField>` is the schema doing the work), and
  `mustCover` is an ARRAY, which it deliberately renders nothing for — so
  `client.tsx` writes that one field itself in the same `<Form>` and maps the
  textarea into `string[]` in one exported function. `transcription-workflow` stays
  the all-declared example.

One smaller thing it settles: neither writer step carries an empty-reply guard,
because `stepGenerate` already refuses an empty completion as a RETRYABLE
failure. The first draft of the template had both, and both were dead code
re-deriving an SDK decision — worth checking for before adding a guard to a step.

Both LLM-driven VOICE ports are tested by SCRIPTING `ctx.generate` on the
system prompt each node carries, so what a spec asserts is WHICH NODES RAN,
which is the part of a graph port that can actually regress. **`stubGenerate`
(`@alexkroman1/aai/testing`) is that fake now** — its script is keyed by system
prompt, which is the same shape both templates had reached for by hand, and it
owns the `{ text, object }` envelope. That envelope is why it is worth having:
`GenerateFn`'s schema overload declares `object` as required, so a hand-written
fake with one `{ text }`-only branch is unassignable AS A WHOLE, and both
templates carried a comment explaining that to the next reader.

What each template keeps is its own TRANSCRIPT: `support-line`'s routes push
node names (`grade_documents:D1`) into a local array, because the assertions are
about the graph rather than about the calls, while `plan-and-execute` reads
`stubGenerate`'s own `calls` — the prompt of the turn after a failed search is
exactly what its "a failed search goes back to the model" test is about.

**`executive-assistant` — their drafting model IS the voice model, and the
interrupt is four tools.** EAIA's `draft_response` binds six pydantic tools to
an LLM with `tool_choice="required"` and reads the chosen call's arguments as
the draft. A voice session already has a model choosing tools every turn, so
those six are `tools/` and `EMAIL_WRITING_INSTRUCTIONS` is the RESULT of
`open_email`, with the four memory prompts interpolated when it is called — the
same move as `travel-concierge`'s brief, for a sharper reason: memory changes
mid-call and a system prompt does not. The three nodes that really are separate
model calls (triage, the tone rewrite, reflection) run as `ctx.generate` inside
the tools, each under its own `system` constant so `stubGenerate` can script
them apart. Four things are decisions:

- **The Agent Inbox's `accept` / `edit` / `ignore` / `respond` are tools gated on
  `awaitingDecision`**, and their per-interrupt `HumanInterruptConfig` is
  `ALLOWED` in `shared.ts`, checked before the body: `accept` on a question or a
  heads-up is refused with the two answers that ARE offered. `applyProposal`
  (`review.ts`) is the one write to the outside world, and every drafting tool
  ends in `propose`, which refuses a second proposal — the concurrent-step lesson
  `travel-concierge`'s `stageAction` paid for.
- **Their reflection graphs run inside `edit` and `respond` and write to the
  SESSION.** `reflect` (`nodes.ts`) is their two steps — choose which of the four
  prompts the feedback touches, rewrite each in parallel — held to the
  `prompt_types` each of their human nodes passes, so an answer to a question can
  teach `background` and nothing else. The store that outlives a run has no
  equivalent without a database, so memory starts from `config.yaml` on every
  call and the sidebar shows what this call learned; the spec pins that the next
  `draft_reply` reads the rewritten tone prompt.
- **`find_meeting_time` is a ReAct agent over one calendar tool, so it is a
  `subagent`**, and its tool lives in `meeting.ts` rather than `tools/`: the
  executive's own model cannot read the calendar except through the specialist,
  which is their node's isolation kept by construction.
- **`NewEmailDraft` is in their tool list and routed by nothing** — `take_action`
  sends it to `bad_tool_name`. `new_email` here is the arm their prompt
  describes, rewritten and staged like a reply, and says so in place.

Two things the seed forces. `TODAY` is fixed, because the meeting assistant
reasons about "next week" against a frozen calendar. And every `open_email`
result — thread plus brief plus memory — is asserted under the 4000-character
tool-result cap per seeded email, since the brief is the one place a growing
memory would overflow silently.
