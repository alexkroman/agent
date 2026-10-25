// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `eval-assert`.
 *
 * The assertion VOCABULARY over what an eval drove: every pure reader and
 * claim over a turn, a call list, an event stream or a finished workflow run
 * (`saidIn`, `toolCallsInEvents`, `toolArgsIn`, `toolResultIn`,
 * `lastStateIn`, `turnCalling`, `expectCalled`, `expectToolBeforeSpeech`,
 * `describeTurn`, `transcriptOf`, `completedOutput`, …), and the two records
 * they read — `EvalTurn` and `EvalToolCall`.
 *
 * Its own capability, and the STABLE one of the family: a reader is a pure
 * function of a record, so it moves when the record does and not when the
 * harness that produced it does. The drivers and their options are `eval`'s;
 * the simulated caller and judge `eval-simulate`'s; the fake network
 * `eval-network`'s; the phone menu `eval-phone-tree`'s.
 *
 * `EvalTurn` and `EvalToolCall` are owned here rather than by `eval`, although
 * the session hands them out, because a caller-implemented `SimulationTarget`
 * RETURNS one — they are records both sides build, which is why neither is
 * tagged `@sealed` or `@input`.
 *
 * Re-exported from `@alexkroman1/aai-runtime/eval` and `/eval/vitest`. This
 * file is not shipped and nothing imports it — it exists so
 * `pnpm check:api-contracts` can extract a report for this capability alone,
 * hash it, and hold it to a committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
  completedOutput,
  customEventsIn,
  describeToolCalls,
  describeTurn,
  type EvalToolCall,
  type EvalTurn,
  // `EvalTurn.workflowStarts` and the reader that picks a def's run id off a turn.
  type EvalWorkflowStart,
  errorsIn,
  evalRunOf,
  expectCalled,
  expectToolBeforeSpeech,
  lastStateIn,
  lastToolResultIn,
  runCodeIn,
  runCodeOutput,
  saidIn,
  statesIn,
  TURN_ENDS,
  toolArgsIn,
  toolCallsInEvents,
  toolCallsInTurns,
  toolNames,
  toolResultIn,
  toolResultsIn,
  transcriptOf,
  turnCalling,
} from "../../eval-barrel.ts";
