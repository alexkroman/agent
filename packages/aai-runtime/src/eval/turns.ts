// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading a CALL — a sequence of turns — rather than one reply.
 *
 * `eval/events.ts` reads one event list; `EvalSession.say()` hands back one
 * {@link EvalTurn}. What sat between them and was hand-rolled in every template
 * that drives more than one utterance is the sequence: every tool call across a
 * whole call, and the turn a mechanism actually fired in.
 *
 * **That last one is the load-bearing idea, and it is why these are published
 * rather than left as four lines per file.** Three template evals independently
 * wrote the same paragraph above their own copy: a case must assert about the
 * turn a MECHANISM fired in, never about turn number two, because how many turns
 * an agent takes to get somewhere is the model's business and it measurably
 * varies — `retail-orders-agent`'s desk reads an order back before it stages, and its staging
 * call has landed in turn two, three and four across live runs. A case pinned to
 * a turn index is a flake with a misleading name, and it fails on a change to
 * the agent's manner rather than to its behaviour.
 *
 * So {@link turnCalling} is the spelling that makes the right claim cheap, and
 * `EvalSession.sayAll()` is what produces the list it reads. The three of them
 * are one affordance split across two modules only because a method belongs on
 * the session.
 *
 * These live here rather than in `eval/events.ts` for a mechanical reason worth
 * stating: {@link EvalTurn} is declared in `eval/session.ts`, which imports
 * `eval/events.ts` — so a function over turns placed there would close a cycle.
 * The dependency runs `turns.ts` -> `session.ts` -> `events.ts` and only that
 * way. The alternative was to type the parameter structurally, which was
 * rejected because a structural `{ text, toolCalls }` cannot see `completed`,
 * and a cancelled reply is exactly what explains a turn that said nothing.
 *
 * @module
 */

import type { ToolDef } from "@alexkroman1/aai";
import { toolNameOf } from "@alexkroman1/aai/testing";
import { type AnyWorkflowDef, workflowNameOf } from "@alexkroman1/aai/workflow-api";
import { describeToolCalls, type EvalToolCall } from "./events.ts";
import type { EvalTurn, EvalWorkflowStart } from "./session.ts";

/**
 * How much of a reply a failure message carries.
 *
 * A reply is a spoken paragraph and a case's message is read in a terminal
 * beside a stack, so the whole of a long one buries the tool list it sits next
 * to. Elided rather than truncated: the length is printed, so a reader can tell
 * a cut-off reply from one that really ended there.
 */
const SAID_MAX = 240;

/**
 * One turn as one line — what the agent did, for the message argument of a
 * failing assertion.
 *
 * **The highest-count duplication in the eval corpus**: ten sites across five
 * templates, four of them byte-identical
 * (`` `tools called: [${turn.toolCalls.map((c) => c.name).join(", ")}]; said: ${turn.text}` ``),
 * and every one of them the `message` argument to `expect(value, message)`. That
 * is the harness's own job. The readers in `eval/events.ts` throw with names
 * precisely because a legible failure is what makes a noisy instrument usable,
 * and then each case built the sentence by hand anyway.
 *
 * What it is worth is the failure it turns into a finding.
 * `expect(started).toBeDefined()` prints "expected undefined to be defined",
 * which says nothing about a concierge that talked through three turns without
 * ever staging the change — the failure `travel-concierge-agent`'s own comment records
 * this message catching.
 *
 * Three things it says that a hand-rolled copy did not:
 *
 * - **"called no tools"**, never `[]`. The empty list is the case the message
 *   exists for — the agent answered with a question instead of acting — and an
 *   empty bracket reads like the message got truncated.
 * - **"said nothing"**, never a trailing `said: `. A reply with no committed
 *   text is a real outcome and the bare form reads as a broken message.
 * - **"(the reply was cancelled)"**, which is usually the REASON for the other
 *   two: a cancelled reply is a finding rather than a harness failure
 *   ({@link EvalTurn.completed}), and it is the one fact that explains a turn
 *   that did nothing and said nothing.
 *
 * ```ts
 * import { describeTurn, type EvalTurn } from "@alexkroman1/aai-runtime/eval";
 *
 * export function stagedOn(turn: EvalTurn): void {
 *   const staged = turn.toolCalls.find((call) => call.name === "update_ticket");
 *   if (staged === undefined) throw new Error(describeTurn(turn));
 * }
 * ```
 */
export function describeTurn(turn: EvalTurn): string {
  const said = turn.text === "" ? "said nothing" : `said ${elide(turn.text)}`;
  return `${describeToolCalls(turn.toolCalls)}; ${said}${
    turn.completed ? "" : " (the reply was cancelled)"
  }`;
}

/** A reply quoted for a one-line message, with a long one's length named. */
function elide(text: string): string {
  return text.length <= SAID_MAX
    ? JSON.stringify(text)
    : `${JSON.stringify(`${text.slice(0, SAID_MAX)}…`)} (${text.length} chars)`;
}

/**
 * Every tool call across `turns`, flattened, in call order — the whole call.
 *
 * `EvalSession.toolCalls()` answers the same question about the SESSION, and the
 * difference is the greeting: the session's list carries every call from the
 * agent's opening line onward, where this carries only the turns a case actually
 * drove. A claim about "the call" that accidentally includes the greeting is the
 * same class of mistake as a claim about `said()` that does — see
 * {@link EvalTurn}.
 *
 * Hand-rolled in `travel-concierge-agent` as `callsIn`, which is where the shape comes
 * from. Pair it with `toolNames` for an order claim, or with `toolArgsIn` /
 * `toolResultsIn` for what each was asked and answered.
 */
export function toolCallsInTurns(turns: readonly EvalTurn[]): readonly EvalToolCall[] {
  return turns.flatMap((turn) => turn.toolCalls);
}

/**
 * The agent ACTED before it spoke: this turn's first `tool.called` precedes its
 * first committed reply.
 *
 * "Report RESULTS, never intentions" is a rule two shipped prompts state and a
 * model routinely breaks — "Let me look that up." and then the search, so the
 * caller hears a promise and then dead air while the tool runs. Two templates
 * asserted it by hand-indexing the event stream (`findIndex` twice, three
 * `expect`s), which on failure prints "expected 4 to be less than 2" and names
 * neither the sentence nor the tool. This names both.
 *
 * Both halves have to be present: a turn that called nothing has nothing to
 * order, and a turn that said nothing reported no result at all — each is its
 * own finding and each throws saying which.
 *
 * A THROW rather than a predicate, which is the exception to "readers, not
 * assertions" that `eval-barrel.ts` argues: the ordering has no value to hand
 * back, and a `toBe(true)` over a boolean would lose the sentence.
 *
 * ```ts
 * import { type EvalTurn, expectToolBeforeSpeech } from "@alexkroman1/aai-runtime/eval";
 *
 * export function searchedFirst(turn: EvalTurn): void {
 *   // The search comes before the answer, not after a sentence announcing one.
 *   expectToolBeforeSpeech(turn);
 * }
 * ```
 */
export function expectToolBeforeSpeech(turn: EvalTurn): void {
  const firstTool = turn.events.find((e) => e.type === "tool.called");
  const firstSaid = turn.events.find((e) => e.type === "agentTranscript.committed");
  if (firstTool === undefined) {
    throw new Error(`no tool was called, so nothing came before speech: ${describeTurn(turn)}`);
  }
  if (firstSaid === undefined) {
    throw new Error(
      `the turn said nothing, so there is no reply to order the call against: ${describeTurn(turn)}`,
    );
  }
  if (turn.events.indexOf(firstSaid) < turn.events.indexOf(firstTool)) {
    throw new Error(
      `the agent spoke before it acted — said ${elide(firstSaid.text)} and only then called ` +
        `${firstTool.toolName}`,
    );
  }
}

/**
 * Every tool in `tools` was called in this turn, and a throw naming what the
 * agent did INSTEAD when one was not. Takes the DEF, as every reader next door
 * does (`toolResultIn(calls, def)`, {@link turnCalling}): the tool file's
 * default export, a speaker's `tools` entry, `toolOf(agentDef, name)` for a
 * minted tool or `builtinTool(name)` for a builtin, matched against the wire by
 * the name the agent registered it under (`toolNameOf`). A name string does
 * not compile, and a renamed file fails at the lookup naming the def rather
 * than as a claim that quietly matched nothing.
 *
 * ## The finding this exists to name
 *
 * A live model calls a median of ONE tool per reply and then speaks — the
 * measurement is on `DEFAULT_MAX_STEPS`, p50 1 and p90 3 across 815 replies — so
 * "the agent announced what it was about to do and ended its turn" is the single
 * most common way a case fails. It is the sibling of
 * {@link expectToolBeforeSpeech}: that one reads the ORDER of a turn that did
 * both, this one is for a turn that did not act at all.
 *
 * It had no name, so it arrived as four different sentences across one
 * afternoon, none of which says what happened:
 *
 * ```text
 * expected [] to deeply equal [ 'recommend' ]
 * expected undefined to be defined
 * expected -1 to be greater than or equal to 0
 * expected [ 'open_email' ] to include 'draft_reply'
 * ```
 *
 * What a reader needs is the tools that WERE called and the sentence the agent
 * said in place of the one it skipped — which is what makes "it promised and
 * stopped" distinguishable from "it reached for the wrong tool" without opening
 * the transcript. The message names each tool by its wire name, the one the
 * transcript shows.
 *
 * ```ts
 * // file: tools/open_email.ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Open an email",
 *   inputSchema: z.object({ id: z.string() }),
 *   execute: ({ id }) => ({ id, body: "…" }),
 * });
 *
 * // file: tools/draft_reply.ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Stage a reply",
 *   inputSchema: z.object({ id: z.string(), text: z.string() }),
 *   execute: () => ({ state: "staged" }),
 * });
 *
 * // file: agent.eval.test.ts
 * import { expectCalled, type EvalTurn } from "@alexkroman1/aai-runtime/eval";
 * import draftReply from "./tools/draft_reply.ts";
 * import openEmail from "./tools/open_email.ts";
 *
 * export function stagedTheDraft(turn: EvalTurn): void {
 *   // Throws: `never called draft_reply — called open_email, and said "I'll
 *   // draft a yes."` rather than `expected [ 'open_email' ] to include …`.
 *   expectCalled(turn, openEmail, draftReply);
 * }
 * ```
 *
 * A THROW rather than a predicate, for {@link expectToolBeforeSpeech}'s reason:
 * the value worth having is the sentence, and a boolean loses it.
 *
 * Takes a turn LIST as readily as a turn, so `sayAll`'s result passes straight
 * in — the shape most claims want, since a model calling one tool per reply
 * cannot satisfy a two-tool claim inside one.
 */
export function expectCalled(
  scope: EvalTurn | readonly EvalTurn[],
  ...tools: readonly ToolDef[]
): void {
  // The defs are resolved to wire names up front, so a def no agent lowered
  // fails with `toolNameOf`'s sentence before any claim about the turn is made.
  const names = tools.map((tool) => toolNameOf(tool));
  // A LIST as readily as a turn, because most claims worth making are about the
  // SESSION rather than one reply: a live model calls a median of one tool per
  // reply, so demanding two in one turn is demanding it chain. `sayAll`'s result
  // passes straight in.
  const turns: readonly EvalTurn[] = Array.isArray(scope) ? scope : [scope as EvalTurn];
  const called = turns.flatMap((turn) => turn.toolCalls.map((call) => call.name));
  const missing = names.filter((name) => !called.includes(name));
  if (missing.length === 0) return;
  // "called nothing and spoke" is the announcing case and gets said outright,
  // because it is the one a reader would otherwise have to infer from an empty
  // list. A scope that called something else is a different finding.
  const spoken = turns
    .map((turn) => turn.text)
    .filter((text) => text !== "")
    .join(" ");
  const instead =
    called.length === 0
      ? `called no tools and ${spoken === "" ? "said nothing" : `only spoke — ${elide(spoken)}`}`
      : `called ${called.join(", ")}${spoken === "" ? "" : `, and said ${elide(spoken)}`}`;
  throw new Error(`never called ${missing.join(", ")} — ${instead}`);
}

/**
 * The turn `tool` was called in — the FIRST one, and a throw naming what
 * happened instead when there is none. Takes the DEF, as every reader next door
 * does (`toolResultIn(calls, def)`): the tool file's default export, a
 * speaker's `tools` entry, `toolOf(agentDef, name)` for a minted tool or
 * `builtinTool(name)` for a builtin, matched against the wire by the name the
 * agent registered it under (`toolNameOf`). A name string does not compile.
 *
 * The claim a multi-turn case actually wants to make, and the whole reason
 * {@link EvalSession.sayAll} exists: "the desk staged the change on the turn it
 * staged it", never "on turn two". Written out in `retail-orders-agent` as `turnCalling`, in
 * `travel-concierge-agent` as `stagingTurn` and in `emergency-dispatch-agent` as an inline
 * `turns.find(…)`, each under a doc making the same argument.
 *
 * **It THROWS rather than answering `undefined`, which is a deliberate break
 * with the shape the templates had.** Every one of them wrote
 * `const staging = turnCalling(turns, tool)` followed by
 * `expect(staging, "<hand-built message>").toBeDefined()` and then read fields
 * off `staging?.…` — three lines and an optional chain to recover from a `find`
 * that missed. This is the rule the readers next door already follow: the
 * singular form throws because for it an absent match can only be a mistake, and
 * the plural answers `[]` because "it never called this" is a claim a case
 * makes. The plural spelling of THIS claim is
 * `expect(toolNames(toolCallsInTurns(turns))).not.toContain(name)`, which needs
 * no turn at all — so nothing is lost, and the return type is `EvalTurn` rather than
 * `EvalTurn | undefined`, which is what retires the optional chain.
 *
 * The throw carries what a hand-built message could not afford to: every turn's
 * tool list, in order, so the failure reads as the shape of the call rather than
 * as one missing name.
 *
 * `where` narrows to a call that also satisfies a predicate — the near-variant
 * `travel-concierge-agent` needed, where the interesting turn is the one whose
 * `update_ticket` STAGED something rather than being refused by the gate. When
 * the tool was called and no call matched, the message says so rather than
 * reporting the tool as never called: those are different findings and only one
 * of them is about the agent ignoring the tool.
 *
 * ```ts
 * // file: tools/cancel_pending_order.ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Stage a cancellation",
 *   inputSchema: z.object({ orderId: z.string() }),
 *   execute: () => ({ state: "pending" }),
 * });
 *
 * // file: agent.eval.test.ts
 * import { type EvalSession, toolResultIn, turnCalling } from "@alexkroman1/aai-runtime/eval";
 * import cancelPendingOrder from "./tools/cancel_pending_order.ts";
 *
 * export async function stagesBeforeCommitting(session: EvalSession): Promise<string> {
 *   const turns = await session.sayAll(["I want to cancel W1234", "Go ahead."]);
 *   // The turn it staged in, whichever that turned out to be.
 *   const staging = turnCalling(turns, cancelPendingOrder);
 *   return toolResultIn(staging.toolCalls, cancelPendingOrder).state;
 * }
 * ```
 */
export function turnCalling(
  turns: readonly EvalTurn[],
  tool: ToolDef,
  where?: (call: EvalToolCall) => boolean,
): EvalTurn {
  const name = toolNameOf(tool);
  const found = turns.find((turn) =>
    turn.toolCalls.some((call) => call.name === name && (where === undefined || where(call))),
  );
  if (found !== undefined) return found;
  const attempts = toolCallsInTurns(turns).filter((call) => call.name === name);
  const missed =
    attempts.length > 0
      ? `${attempts.length} call(s) to ${JSON.stringify(name)} and none matched the predicate`
      : `no turn called ${JSON.stringify(name)}`;
  const shape =
    turns.length === 0
      ? "no turns were driven"
      : turns.map((turn, at) => `turn ${at + 1} ${describeToolCalls(turn.toolCalls)}`).join("; ");
  throw new Error(`${missed}: ${shape}`);
}

/**
 * The id of the ONE run of `workflow` a tool started during `turn` — read off
 * the session's recorded `ctx.workflows.start`, not off the tool's answer.
 *
 * Every hand-off eval needed the run id to read the run back
 * (`workflows.settle(runId, def)`), and each parsed it out of the tool's
 * serialized result with a schema of its own: `toolResultsIn(calls,
 * "request_recap", RecapStart)[0].runId`, behind a helper explaining why the
 * singular reader would refuse a second call. That reads the id through the
 * MODEL's copy of what the tool said, which is one translation away from the
 * fact: the session handed the tool a client, and the client knows what was
 * started. {@link EvalTurn.workflowStarts} is that record; this is its reader.
 *
 * By DEF or by the declared name, either way matched against what the agent
 * declares — so a tool that started by name and a case that asks by def agree.
 * EXACTLY one, like `toolResultIn`: zero is a tool that answered without
 * starting anything, two is the finding a dedupe check exists to prevent, and
 * both throw naming what the turn did start.
 *
 * ```ts
 * import type { AnyWorkflowDef } from "@alexkroman1/aai/workflow-api";
 * import { type EvalSession, type EvalWorkflows, evalRunOf } from "@alexkroman1/aai-runtime/eval";
 *
 * declare const recap: AnyWorkflowDef<{ headline: string }>; // the def `agent.ts` declares
 * declare const workflows: EvalWorkflows; // `openEvalWorkflows(…)`
 * declare const session: EvalSession; // `openEvalSession({ agent: agentDef, workflows })`
 *
 * const started = await session.say("Can you write up that recording for me?");
 * const runId = evalRunOf(started, recap);
 * const run = await workflows.settle(runId, recap);
 * ```
 */
export function evalRunOf(turn: EvalTurn, workflow: string | AnyWorkflowDef): string {
  const starts = turn.workflowStarts;
  if (starts === undefined) {
    throw new Error(
      "evalRunOf: this turn carries no record of workflow starts — only a turn `openEvalSession`'s " +
        "`say()` built records them, and a turn built by a `SimulationTarget` of your own does not.",
    );
  }
  const matching = starts.filter((start) =>
    typeof workflow === "string" ? start.workflow === workflow : start.def === workflow,
  );
  // A def is named by the key it was declared under when the agent recorded
  // one (`workflowNameOf`), and by its description otherwise.
  const asked =
    typeof workflow === "string"
      ? JSON.stringify(workflow)
      : (workflowNameOf(workflow) ??
        `the def described as ${JSON.stringify(workflow.description ?? "")}`);
  if (matching.length === 0) {
    const did =
      starts.length === 0
        ? "started no runs"
        : `started ${starts.map((start) => `${start.workflow} (${start.runId})`).join(", ")}`;
    throw new Error(`evalRunOf: no run of ${asked} was started in this turn; it ${did}`);
  }
  if (matching.length > 1) {
    throw new Error(
      `evalRunOf: ${matching.length} runs of ${asked} were started in this turn ` +
        `(${matching.map((start) => start.runId).join(", ")}) — read them off turn.workflowStarts yourself`,
    );
  }
  const [only] = matching as [EvalWorkflowStart];
  return only.runId;
}
