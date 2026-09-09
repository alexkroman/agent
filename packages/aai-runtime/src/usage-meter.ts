// Copyright 2026 the AAI authors. MIT license.
/**
 * What a session has spent, counted HOST-SIDE from what the provider reports.
 *
 * Before this the SDK reported no usage at all — `maxSteps` was the only budget
 * an agent had, and a step is not a cost: one step that sends a 100k-token
 * context and one that sends a greeting are the same step. Every peer exposes
 * this (Anthropic `maxBudgetUsd` + `maxTurns`, Pydantic `UsageLimits` +
 * `RunUsage`, OpenAI usage on the run result), and none of them could be
 * imitated without a number to count.
 *
 * ## What feeds it
 *
 * Every model request the HOST assembles for this session, which is three
 * places rather than the one this started as:
 *
 * | Spender | Reported by |
 * | --- | --- |
 * | the conversational loop (pipeline / text) | each step's `onStepFinish` |
 * | `ctx.generate` from a tool body | `createGenerateFn`'s own `onStepFinish` |
 * | `ctx.delegate` / `subagent()` | each step of the delegated tool loop |
 *
 * It shipped fed by the FIRST alone, and that is the failure this section
 * exists to keep closed. A delegating agent spends almost everything it spends
 * inside `ctx.delegate` — a subagent run is a full nested tool loop, often on a
 * larger model and a longer context than the turn that started it — and a
 * planner spends it inside `ctx.generate`. So a budget declared on either
 * bounded the cheapest part of the session while reading as though it bounded
 * the session, which is worse than no budget: an author sets one and believes
 * they are covered. Two template adoptions rejected the field for exactly that,
 * independently, before anything else used it.
 *
 * **A new host-side model call OWES this meter a report**, and the place to add
 * one is the tool call's own option bag (`ExecuteToolCallOptions.usage`) — it
 * is carried into a delegated run by subtraction, so a capability added to a
 * tool context cannot be silently missing from a delegated one.
 *
 * ## What it does NOT count, and why
 *
 * Named here rather than discovered, because the whole defect above was a doc
 * that promised more than the code counted:
 *
 * - **S2S cannot count the CONVERSATIONAL LOOP, which is almost all of what it
 *   spends.** There the provider runs the loop itself and reports no token
 *   counts to the host, so its turns are unmeasurable and
 *   `agent({ usageLimits })` is refused at config time
 *   (`assertSamplingScope`) rather than accepting a budget nothing could
 *   enforce. What is missing is the FEED, not the meter: one is built for every
 *   session whatever its mode (`runtime-session-controls.ts`) and every tool
 *   call carries it (`runtime-tools.ts`), so an s2s agent whose tool calls
 *   `ctx.generate` or `ctx.delegate` really does meter those — they are
 *   host-side model requests like any other, and rows two and three of the
 *   table above apply unchanged. Reporting the loop's turns as zeroes would be
 *   the one outcome worse than reporting nothing: a budget that never trips
 *   reads exactly like a session under budget.
 * - **A durable WORKFLOW step is out of scope, not merely unwired.** A run
 *   outlives the session that started it — it is resumed by the engine's own
 *   timers, possibly in another process days later, and a REPLAYED step reads
 *   its journaled result and makes no model call at all — so "what this session
 *   spent" is not a question a step's tokens have an answer to. `stepGenerate`
 *   is a raw `fetch` in the SDK and `stepDelegate` runs on a SESSIONLESS parent
 *   bag (`step-delegate.ts`), so neither has a session to report to even in the
 *   process that started the run. Bounding a run's spend is a run-scoped budget
 *   and a different feature; {@link UsageLimits.totalTokens} says so.
 * - **A RELAYED tool call spends in another process.** In sandbox/host-relay
 *   mode a custom tool executes behind an RPC, so its `ctx.generate` reaches
 *   the meter of whichever runtime is executing it and not this one. Builtins,
 *   which run host-side, are counted.
 *
 * ## Two deliberate limits
 *
 * **The unit is TOKENS, never money.** A price is per-model, per-region and
 * per-contract, and this package carries no table of them. A budget that
 * silently guesses is worse than one stated in the unit the provider actually
 * reports, so `UsageLimits` has `totalTokens` and no `maxCostUsd`.
 *
 * **It counts what the PROVIDER said, not what this process estimated.** The
 * numbers come off each completed step's reported usage (the AI SDK's `usage`
 * on `onStepFinish`), so a provider that meters cached reads differently from
 * fresh ones is honoured rather than second-guessed. `totalTokens` is taken as
 * reported rather than recomputed from the two parts, for the same reason —
 * some providers bill a line item that appears in neither.
 *
 * ## Where the cap is enforced
 *
 * BEFORE a request, never mid-stream — and before EVERY request the host makes,
 * which is the same list the feed table above carries. A cap that fired
 * mid-sentence would cut the agent off in the middle of speech and the caller
 * would hear a dropped call rather than a limit; so the request in flight
 * finishes, and the next one is refused wherever it is about to be made: the
 * next turn (`pipeline-turn-body.ts`, `text-agent.ts`), the next `ctx.generate`
 * (the forwarder in `tool-executor.ts`), the next delegated attempt
 * (`runUntilAccepted`).
 *
 * **Checking only at the turn was the other half of the under-counting bug.** A
 * tool that fans out to six subagents crosses the line on the first and spends
 * the other five before anything asks again, so the effective overrun was a
 * whole fan-out rather than a turn. Now the overrun is one request, and
 * {@link UsageLimits.totalTokens} documents that.
 *
 * A refused `ctx.generate` or `ctx.delegate` REJECTS with this sentence rather
 * than answering emptily: it reaches the tool's own `catch`, and failing that
 * the executor turns it into a tool failure the model reads — which is the
 * right shape, since the session is about to end on the next turn anyway and
 * the model's last act should not be improvising over a silently empty answer.
 */

/** Everything one session has spent so far. @internal */
export interface UsageSnapshot {
  /** Prompt tokens across every step of every turn. */
  inputTokens: number;
  /** Generated tokens across every step of every turn. */
  outputTokens: number;
  /** As the provider reported it — see this module's header. */
  totalTokens: number;
  /** Completed model requests behind those numbers. */
  steps: number;
}

/**
 * What one completed step reported.
 *
 * Every field optional and possibly `undefined`, because that is what the
 * vendor type says and what real providers do: a gateway that omits
 * `inputTokens` on a cached turn is common, and `NaN`/`undefined` arriving into
 * a running total is how a budget silently stops working.
 *
 * Public rather than `@internal`, unlike its two neighbours here: it is the
 * parameter of `HostGenerateFn`'s `onUsage`, which `/eval` publishes, so an
 * eval supplying a `generate` double has to be able to write this type.
 * `UsageMeter` and `UsageSnapshot` stay internal and are reachable only from
 * `@alexkroman1/aai-runtime/internal`.
 *
 * @public
 */
export interface StepUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}

/** One session's running total. @internal */
export interface UsageMeter {
  /** Fold in one completed step and announce the new total. */
  record(usage: StepUsage | undefined): void;
  /** The running total. */
  snapshot(): UsageSnapshot;
  /**
   * Why a further model request must not be made, or `undefined`.
   *
   * A SENTENCE rather than a boolean: the caller's only job with it is to put
   * it on the session's error stream, and a boolean would mean writing the
   * explanation at each call site instead of beside the rule.
   */
  exhausted(): string | undefined;
}

/** A number the provider really reported; anything else contributes zero. */
function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Build a session's meter.
 *
 * `onUpdate` fires on every recorded step, including the ones that report
 * nothing — a step is a step, and `steps` is what tells a reader whether a
 * provider is reporting usage at all. A total that never moves while `steps`
 * climbs is the signature of a provider that meters nothing, which is worth
 * being able to see.
 *
 * **It is OPTIONAL, and absent means nobody is reading.** Recording is
 * in-memory and free, so it happens for every session; announcing is not —
 * each snapshot is an allocation on the per-STEP path, and on the pipeline it
 * becomes a durable event and a client frame besides (see
 * `runtime-session-controls.ts`, which decides when a session has a reader).
 * So the spread is paid by a meter that has a sink and by no other:
 * `snapshot()` still answers the live total either way.
 *
 * @internal
 */
export function createUsageMeter(deps: {
  limits?: { totalTokens?: number | undefined } | undefined;
  onUpdate?: ((snapshot: UsageSnapshot) => void) | undefined;
}): UsageMeter {
  const total: UsageSnapshot = { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 0 };
  const cap = deps.limits?.totalTokens;
  const onUpdate = deps.onUpdate;
  return {
    record(usage) {
      const input = finite(usage?.inputTokens);
      const output = finite(usage?.outputTokens);
      total.inputTokens += input;
      total.outputTokens += output;
      // The reported total when there is one, the sum of the parts otherwise —
      // so a provider that reports only the two halves still drives a budget,
      // and one that reports a total including a third line item is believed.
      total.totalTokens += finite(usage?.totalTokens) || input + output;
      total.steps += 1;
      // The snapshot is COPIED for a reader, so it is built only when there is
      // one — see the note on `onUpdate` above.
      onUpdate?.({ ...total });
    },
    snapshot: () => ({ ...total }),
    exhausted() {
      if (cap === undefined || total.totalTokens < cap) return;
      return (
        `This session has used ${total.totalTokens} tokens, which is its \`usageLimits.totalTokens\` ` +
        `budget of ${cap}. No further model requests will be made.`
      );
    },
  };
}
