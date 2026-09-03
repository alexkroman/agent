// Copyright 2026 the AAI authors. MIT license.
/**
 * A fake `ctx.delegate`, for testing a tool body that hands work to a subagent.
 *
 * The loop-side twin of {@link stubGenerate}, and routed the same way for the
 * same reason — by the thing that tells one call from another. For `generate`
 * that is the SYSTEM prompt; here it is the SUBAGENT'S NAME, which is what a
 * tool delegating to a researcher and a fact-checker actually varies. An
 * unrouted call rejects naming the subagent it carried, so a spec cannot drive
 * a two-subagent tool through one arm and call it covered.
 *
 * What it does NOT do is run the subagent's tools. That is the point of the
 * seam: a subagent is a model loop, and a spec that wanted to assert on its
 * steps would be asserting on a provider's choices. Test the subagent's TOOLS
 * directly — they are ordinary `tool()` defs and take an ordinary
 * `createToolContext()` — and test the parent tool against what a run
 * RETURNS.
 */

import type {
  DelegateFn,
  DelegateOptions,
  DelegateResult,
  SubagentDef,
  SubagentToolCall,
} from "./subagent.ts";
import { isRecord } from "./utils.ts";

/** One `ctx.delegate` call, as recorded by {@link stubDelegate}. */
export interface StubDelegateCall {
  /** The subagent that was asked. */
  subagent: SubagentDef;
  /** The task it was given. */
  task: string;
  /** The whole options object, for asserting `context` and `maxSteps`. */
  options: DelegateOptions;
}

/**
 * What one route answers with.
 *
 * A bare string is the subagent's final text with an empty cost report, which
 * is what a tool that only reads `text` wants. The object form fills in
 * `steps` and `toolCalls` for a tool that narrates the wait.
 *
 * @public
 */
export type StubDelegateReply =
  | string
  | { text: string; steps?: number; toolCalls?: readonly SubagentToolCall[] };

/**
 * How a route answers: a fixed reply, or a function of the call — the function
 * form being what a route asked more than once (a subagent run per document)
 * needs in order to shift its own script.
 *
 * @public
 */
export type StubDelegateRoute = StubDelegateReply | ((call: StubDelegateCall) => StubDelegateReply);

/** A fake `ctx.delegate`: the function to pass, and what it was asked. */
export interface StubDelegate {
  /** Pass as `delegate` to `createToolContext`. */
  delegate: DelegateFn;
  /** Every call, in order. */
  calls: StubDelegateCall[];
}

/**
 * Build a fake `ctx.delegate` from a script keyed by subagent name.
 *
 * Pass a single route (not a record) to answer every delegation the same way,
 * which is what a one-subagent tool wants.
 *
 * @example Two subagents, one queue
 * ```ts
 * import { createToolContext, stubDelegate } from "@alexkroman1/aai/testing";
 *
 * const findings = ["Rain on Tuesday.", "Clear on Wednesday."];
 * const desk = stubDelegate({
 *   researcher: () => ({ text: findings.shift() ?? "Nothing found.", steps: 3 }),
 *   "fact-checker": "Both claims check out.",
 * });
 * const ctx = createToolContext({ delegate: desk.delegate });
 * // … run the tool, then assert on who was asked what:
 * // expect(desk.calls.map((call) => call.subagent.name)).toEqual([…]);
 * ```
 *
 * @public
 */
export function stubDelegate(
  script: Readonly<Record<string, StubDelegateRoute>> | StubDelegateRoute,
): StubDelegate {
  const calls: StubDelegateCall[] = [];
  const routes = isRouteTable(script) ? script : undefined;

  // `async`, and that is load-bearing rather than a style choice: it makes a
  // route that THROWS — which is how a spec scripts a subagent run that failed —
  // come back as a REJECTION, the way the real `ctx.delegate` reports one. A
  // sync throw would escape a caller's `Promise.allSettled` and take down the
  // whole fan-out, so a spec asserting "one failed angle does not sink the
  // briefing" would fail against a tool that handles it correctly.
  const delegate: DelegateFn = async (subagent: SubagentDef, options: DelegateOptions) => {
    const call: StubDelegateCall = { subagent, task: options.task, options };
    calls.push(call);
    const route = routes ? routes[subagent.name] : (script as StubDelegateRoute);
    if (route === undefined) {
      throw new Error(
        `stubDelegate: no route for subagent ${JSON.stringify(subagent.name)}. ` +
          `Routed subagents: ${Object.keys(routes ?? {}).join(", ") || "(none)"}.`,
      );
    }
    return envelope(typeof route === "function" ? route(call) : route);
  };

  return { delegate, calls };
}

/**
 * Is this a table of routes, or one route?
 *
 * Told apart by the reply shape rather than by `typeof`, exactly as
 * `stubGenerate` does it — and for the same reason `StubDelegateReply`'s object
 * form REQUIRES `text`: a table with one route named `text` would otherwise be
 * indistinguishable from a single reply.
 */
function isRouteTable(
  script: Readonly<Record<string, StubDelegateRoute>> | StubDelegateRoute,
): script is Readonly<Record<string, StubDelegateRoute>> {
  return isRecord(script) && !("text" in script);
}

/** The full {@link DelegateResult} a route's shorthand stands for. */
function envelope(reply: StubDelegateReply): DelegateResult {
  if (typeof reply === "string") return { text: reply, steps: 1, toolCalls: [] };
  const toolCalls = reply.toolCalls ?? [];
  // `steps` defaults to one MORE than the tool calls, not to zero: a run that
  // called two tools took at least three steps, and a spec reading `steps` off
  // a fake that said `0` would assert a run that never happened.
  return { text: reply.text, steps: reply.steps ?? toolCalls.length + 1, toolCalls };
}
