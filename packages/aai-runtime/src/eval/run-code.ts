// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading what an agent RAN — the `run_code` builtin's two halves, the code it
 * was handed and what came back.
 *
 * Four template evals — `code-interpreter-agent`, `entertainment-picks-agent` and the two starters
 * since removed as near-duplicates (`math-buddy`, `personal-finance`) — each
 * declared the same `RunCodeArgs` schema and the same
 * `codeIn` reader under the same ten-line comment about reading arguments
 * through a schema, and each then asserted the OUTPUT with
 * `toolResultsIn(turn.toolCalls, "run_code").join("\n")` followed by
 * `not.toMatch(/only available in the sandboxed runtime/)`. That regex is the
 * finding: the templates had re-typed a fragment of a sentence the RUNTIME owns
 * (`createRunCode`'s refusal, in `@alexkroman1/aai`), so a rewording of it
 * would have passed every one of them against a refusal — the exact state the
 * assertion exists to catch, since a tutor whose `run_code` refuses does the
 * arithmetic in its head and reads as correct until it is wrong.
 *
 * So {@link runCodeOutput} imports `RUN_CODE_REFUSAL` — the constant the
 * executor writes — and THROWS on it, naming the fix. Nothing here re-spells the
 * sentence, and a case that reads output cannot read a refusal as output.
 *
 * Both readers take the CALL LIST rather than a turn, like every reader in
 * `events.ts`: a case reading one turn passes `turn.toolCalls`, a case reading a
 * whole call passes `toolCallsInTurns(turns)`.
 *
 * @module
 */

import { RUN_CODE_REFUSAL } from "@alexkroman1/aai/host-internal";
import { z } from "zod";
import { type EvalToolCall, ordinal, toolArgsIn } from "./events.ts";
import { createVmRunCode } from "./vm-run-code.ts";

/** The builtin's name, as the model calls it. */
const RUN_CODE = "run_code";

/**
 * What a `run_code` call carries. Read through `toolArgsIn` WITH a schema —
 * `args` is `Record<string, unknown>` on the wire, the model wrote it and
 * nothing validated it, so a `String(args.code ?? "")` turns an argument the
 * model renamed, or never sent, into `""`, and every claim about the code
 * becomes a claim about an empty string.
 */
const RunCodeArgs = z.object({ code: z.string() });

/**
 * Did this `run_code` result REFUSE rather than run?
 *
 * The refusal is the executor's own sentence, serialized inside a
 * `{ "error": … }` envelope, so containment is the test; a code error the
 * model's own snippet threw (`{ "error": "nope is not defined" }`) is a real
 * result and is NOT this.
 */
export function isRunCodeRefusal(result: string): boolean {
  return result.includes(RUN_CODE_REFUSAL);
}

/**
 * The sentence a refusal throws, and the fix.
 *
 * Composed from short pieces rather than written as one literal: Biome's
 * `noSecrets` reads a long, punctuation-dense string as a high-entropy secret.
 */
function runCodeRefusedMessage(what: string): string {
  const fix = [
    // The executor's own name, read off it: as a literal, `createVmRunCode()`
    // alone reads to `noSecrets` as a high-entropy secret.
    `Pass \`runCode: ${createVmRunCode.name}()\``,
    "to `describeEval` or `openEvalSession`",
    "— a deployed agent runs the code inside its sandbox;",
    "the vm executor is for a developer's own machine.",
  ].join(" ");
  return (
    `${what} REFUSED rather than ran: ${RUN_CODE_REFUSAL} The eval supplied no executor, so ` +
    `any claim about what the code printed would hold against that sentence. ${fix}`
  );
}

/**
 * The code every `run_code` call in `calls` carried, joined with newlines —
 * the recipe the agent wrote.
 *
 * ZERO calls answers `""` rather than throwing, for the reason `toolArgsIn`
 * gives: "it never reached for code" is a claim a case makes
 * (`expect(runCodeIn(turn.toolCalls)).toBe("")`). Assert the CALL first when
 * the claim is that code was written at all — `toolNames(turn.toolCalls)` with
 * `describeTurn(turn)` as the message — or `toContain("Math.random")` fails
 * against an empty string with nothing said about why.
 *
 * A call whose `code` argument stopped arriving as a string FAILS here naming
 * the field, which is what the schema is for.
 *
 * ```ts
 * import { type EvalTurn, runCodeIn, toolNames } from "@alexkroman1/aai-runtime/eval";
 *
 * export function rolledForReal(turn: EvalTurn): boolean {
 *   // A model asked for dice will happily make three numbers up; `Math.random`
 *   // in the code is the only thing that tells a roll from an invention.
 *   return toolNames(turn.toolCalls).includes("run_code") && /Math\.random/.test(runCodeIn(turn.toolCalls));
 * }
 * ```
 */
export function runCodeIn(calls: readonly EvalToolCall[]): string {
  return toolArgsIn(calls, RUN_CODE, RunCodeArgs)
    .map((args) => args.code)
    .join("\n");
}

/**
 * What every `run_code` call in `calls` PRINTED, joined with newlines — the
 * results as the model was handed them, verbatim.
 *
 * Verbatim rather than parsed, unlike `toolResultsIn`: `run_code` prints
 * whatever the snippet printed, so `"Saturday"` and `"3.106855"` are ordinary
 * results, and a snippet that threw comes back as `{"error":"…"}` — which reads
 * as what it is in a failure message, where the parsed form printed
 * `[object Object]`.
 *
 * **A refusal THROWS, naming the fix.** With no executor the builtin answers
 * the sentence `RUN_CODE_REFUSAL` carries, and every claim about output —
 * `toMatch(/8\.0/)`, `not.toBe("")` — holds vacuously against it. The four
 * templates that reached for this each guarded against it with a hand-typed
 * regex; the reader imports the constant instead, so a reworded refusal cannot
 * slip past as output. A call that never completed throws too, naming its
 * position, as `toolResultsIn` does.
 *
 * ZERO calls answers `""`, for the reason {@link runCodeIn} gives.
 *
 * ```ts
 * import { type EvalTurn, runCodeOutput } from "@alexkroman1/aai-runtime/eval";
 *
 * export function convertedFiveMiles(turn: EvalTurn): boolean {
 *   // Five miles is 8.0467 km: whatever rounding the tutor chose, the answer
 *   // starts 8.0 — and a refusal throws before this is ever compared.
 *   return /8\.0/.test(runCodeOutput(turn.toolCalls));
 * }
 * ```
 */
export function runCodeOutput(calls: readonly EvalToolCall[]): string {
  return calls
    .filter((call) => call.name === RUN_CODE)
    .map((call, at) => {
      if (call.result === undefined) {
        throw new Error(`the ${ordinal(at)} call to "${RUN_CODE}" never completed`);
      }
      if (isRunCodeRefusal(call.result)) {
        throw new Error(runCodeRefusedMessage(`the ${ordinal(at)} call to "${RUN_CODE}"`));
      }
      return call.result;
    })
    .join("\n");
}
