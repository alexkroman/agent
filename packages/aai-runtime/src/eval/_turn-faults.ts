// Copyright 2026 the AAI authors. MIT license.
/**
 * Refusing a turn nothing about the AGENT can be read off.
 *
 * `openEvalSession` hands a case an {@link EvalTurn} per utterance, and there
 * are two states in which that turn is not the agent's work at all. Both were
 * measured PASSING, which is why they are a module rather than two lines:
 *
 * - **The pipeline failed the turn.** A `{ live: true }` refusal case
 *   (`expect(turn.text).not.toMatch(/ibuprofen|aspirin/i)`) run against a
 *   REJECTED credential reported one passing test with `turn.completed === true`
 *   — the runtime had reported `llm` twice, once with an EMPTY message, and
 *   answered with `errorPhrase`, which matches no drug name. So the entire class
 *   of negative assertion the authoring guide steers a case to `live: true` FOR
 *   silently inverted into a pass.
 * - **A tool the runtime has no definition for.** A `stubReply` naming one emits
 *   `tool.called`, never `tool.completed`, and leaves `result` undefined — so
 *   `turn.toolCalls[0].result` is permanently undefined and every claim about
 *   what it answered holds vacuously. The usual cause is an eval importing
 *   `./agent.ts`, which carries none of the tools a bundler discovers in
 *   `tools/`.
 *
 * Split out of `eval/session.ts` for the line cap; the argument for each
 * decision sits on the function that makes it.
 *
 * @module
 */

import type { SessionEvent } from "@alexkroman1/aai/protocol";

/**
 * The `error.reported` events in `turn` that mean the reply was the RUNTIME's
 * rather than the agent's, one rendered line each.
 *
 * `code: "tool"` is the one code excluded, and the exclusion is the whole
 * design: a tool that throws has its failure handed back to the model, which
 * then recovers or explains itself, and a case asserting on that recovery is
 * asserting about the AGENT — three shipped templates do exactly that against a
 * gate they expect to refuse. Every other code names a stage this harness either
 * stands in for (`stt`, `tts`) or cannot measure past (`llm`, `connection`,
 * `protocol`, `audio`, `internal`): the pipeline ends the turn and speaks
 * `errorPhrase`, so the "reply" a case reads was written by this runtime. A code
 * the protocol adds later lands here too, which is the safe default — a new
 * failure class should be loud rather than quietly measured.
 *
 * An EMPTY message is rendered as `(no message)` rather than forwarded. That is
 * what a REJECTED CREDENTIAL produces — the provider's own error carries none —
 * so it is the single likeliest message to reach a reader, and `llm: ` reads as
 * a harness that lost the string rather than as a provider that sent none.
 */
function stageFaultsIn(turn: readonly SessionEvent[]): readonly string[] {
  const seen = new Set<string>();
  for (const event of turn) {
    if (event.type !== "error.reported" || event.code === "tool") continue;
    const message = event.message.trim() === "" ? "(no message)" : event.message;
    seen.add(`${event.code}: ${message}${event.fatal ? " [fatal]" : ""}`);
  }
  return [...seen];
}

/**
 * The tools `turn` asked for and the runtime never ran — a `tool.called` with
 * no `tool.completed`.
 *
 * `toolCallsIn` already reports such a call with `result: undefined`, on the
 * stated ground that "it called the tool and the tool never returned" is a
 * finding. It is, and nothing made the case look: `turn.toolCalls[0].result`
 * being permanently `undefined` surfaces as a chai type error four lines into an
 * assertion, or as nothing at all.
 */
function unexecutedToolsIn(turn: readonly SessionEvent[]): readonly string[] {
  const completed = new Set(
    turn.flatMap((event) => (event.type === "tool.completed" ? [event.toolCallId] : [])),
  );
  return [
    ...new Set(
      turn.flatMap((event) =>
        event.type === "tool.called" && !completed.has(event.toolCallId) ? [event.toolName] : [],
      ),
    ),
  ];
}

/**
 * Refuse a turn nothing about the agent can be read off — the one outcome this
 * module must never hand a case, because a case cannot see it.
 *
 * Both halves were measured passing. A `{ live: true }` refusal case
 * (`expect(turn.text).not.toMatch(/ibuprofen|aspirin/i)`) run against a REJECTED
 * credential reported one passing test with `turn.completed === true`: the
 * pipeline had reported `llm` twice — once with an empty message — and answered
 * with `errorPhrase`, which matches no drug name, so the entire class of
 * negative assertion the docs steer an author to `live: true` FOR silently
 * inverted into a pass. And a `stubReply` naming a tool the agent does not
 * declare emitted `tool.called`, no `tool.completed`, and a `result` of
 * `undefined` — with the tool body never entering, though "your tools run" is
 * what the authoring guide promises about a scripted run.
 *
 * A throw rather than a field on {@link EvalTurn}: a field is something a case
 * has to remember to read, and every case in the corpus that would have needed
 * it is one that already passed without it. It also composes — `sayAll` stops on
 * the first unmeasurable turn instead of returning a list with a hole in it. A
 * case that means to OBSERVE a broken turn catches this and reads
 * `session.events()`, which is unaffected.
 */
export function assertTurnMeasurable(
  what: string,
  turn: readonly SessionEvent[],
  toolNames: readonly string[],
): void {
  const faults = stageFaultsIn(turn);
  if (faults.length > 0) {
    throw new Error(
      `eval session: ${what} did not come from the agent — the runtime reported ` +
        // On its own line, and with no punctuation of ours after it: a provider
        // message routinely ends in a full stop of its own, and "…for
        // errors.. A turn" reads as a formatting bug in the harness.
        `${faults.join("; ")}\n` +
        "A turn the pipeline failed is answered with the agent's " +
        '`errorPhrase` ("Sorry, I had a problem just then. Could you say that again?"), so ' +
        "every assertion about what was said passes for the wrong reason — a refusal or " +
        "`not.toMatch` claim most of all. A rejected or expired provider credential is the " +
        "usual cause.",
    );
  }
  // Only for a reply that ended on its own terms: a CANCELLED one legitimately
  // abandons a tool call mid-flight, and that is a finding about barge-in rather
  // than about a tool the runtime could not find.
  if (!turn.some((event) => event.type === "reply.completed")) return;
  const missing = unexecutedToolsIn(turn);
  if (missing.length === 0) return;
  throw new Error(
    `eval session: ${what} asked for ${missing.map((name) => JSON.stringify(name)).join(", ")} ` +
      `and the runtime never ran ${missing.length === 1 ? "it" : "them"}. A \`tool.called\` ` +
      "with no `tool.completed` means there was no such tool to execute, so its `result` is " +
      "undefined and any claim about what it answered holds vacuously. This agent's tools: " +
      `${toolNames.length === 0 ? "(none)" : toolNames.join(", ")}. A file in \`tools/\` is ` +
      "discovered by the bundler and not by `agent()`, so an eval importing `./agent.ts` " +
      "drives a definition with NO tools — import `virtual:aai/agent` instead.",
  );
}
