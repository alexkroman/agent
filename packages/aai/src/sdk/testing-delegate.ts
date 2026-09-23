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

import { omitUndefined } from "./omit-undefined.ts";
import { safeJsonParse } from "./safe-json-parse.ts";
import { formatSchemaIssues } from "./standard-schema.ts";
import { publishStepDelegate } from "./step-delegate.ts";
import { stripJsonFence } from "./step-generate-json.ts";
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
  | {
      text: string;
      steps?: number;
      toolCalls?: readonly SubagentToolCall[];
      /** How many times a guardrail sent an answer back. Defaults to `0`. */
      revisions?: number;
      /**
       * Stage a run the subagent's GUARDRAIL never accepted: the complaint the
       * real runtime returns beside the last rejected attempt.
       *
       * Its presence is what makes the result's `accepted` false — the
       * two cannot be staged apart, because in the runtime they cannot occur
       * apart. A spec cannot describe an unaccepted answer with no reason, and
       * a caller reading `complaint` on an accepted one would be reading a
       * field that is never set.
       */
      complaint?: string;
    };

/**
 * How a route answers: a fixed reply, or a function of the call — the function
 * form being what a route asked more than once (a subagent run per document)
 * needs in order to shift its own script.
 *
 * @public
 */
export type StubDelegateRoute = StubDelegateReply | ((call: StubDelegateCall) => StubDelegateReply);

/**
 * Everything {@link stubDelegate} and {@link stubStepDelegate} accept: ONE route
 * answering every delegation, or a table of routes keyed by subagent name —
 * each under a key that says which.
 *
 * The same two shapes {@link StubGenerateScript} takes, for the same reason: a
 * bare "a table, or a reply" union is told apart at runtime by the reply's
 * shape, so a subagent named `text` could never be routed and a reply object
 * could be read as a table. Named, there is nothing to guess.
 *
 * @public
 */
export type StubDelegateScript =
  | {
      /** Answers EVERY delegation, whichever subagent it names. */
      readonly reply: StubDelegateRoute;
      readonly routes?: never;
    }
  | {
      /**
       * One route per subagent, keyed by its `name`. A delegation naming no
       * route rejects, naming the subagent.
       */
      readonly routes: Readonly<Record<string, StubDelegateRoute>>;
      readonly reply?: never;
    };

/** A fake `ctx.delegate`: the function to pass, and what it was asked. */
export interface StubDelegate {
  /** Pass as `delegate` to `createToolContext`. */
  delegate: DelegateFn;
  /** Every call, in order. */
  calls: StubDelegateCall[];
}

/**
 * Build a fake `ctx.delegate` from a script: one reply, or routes keyed by
 * subagent name.
 *
 * Pass `{ reply }` to answer every delegation the same way, which is what a
 * one-subagent tool wants.
 *
 * @example Two subagents, one queue
 * ```ts
 * import { createToolContext, stubDelegate } from "@alexkroman1/aai/testing";
 *
 * const findings = ["Rain on Tuesday.", "Clear on Wednesday."];
 * const desk = stubDelegate({
 *   routes: {
 *     researcher: () => ({ text: findings.shift() ?? "Nothing found.", steps: 3 }),
 *     "fact-checker": "Both claims check out.",
 *   },
 * });
 * const ctx = createToolContext({ delegate: desk.delegate });
 * // … run the tool, then assert on who was asked what:
 * // expect(desk.calls.map((call) => call.subagent.name)).toEqual([…]);
 * ```
 *
 * @public
 */
export function stubDelegate(script: StubDelegateScript): StubDelegate {
  const calls: StubDelegateCall[] = [];
  const routes = routeTable(script);
  const single = "reply" in script ? script.reply : undefined;

  // `async`, and that is load-bearing rather than a style choice: it makes a
  // route that THROWS — which is how a spec scripts a subagent run that failed —
  // come back as a REJECTION, the way the real `ctx.delegate` reports one. A
  // sync throw would escape a caller's `Promise.allSettled` and take down the
  // whole fan-out, so a spec asserting "one failed angle does not sink the
  // briefing" would fail against a tool that handles it correctly.
  // Declared with the WIDEST signature and asserted, the way `buildToolContext`
  // declares its `generate` forwarder: `DelegateFn` is OVERLOADED — a subagent
  // declaring a `schema` answers with `object` — and TypeScript cannot check an
  // overloaded type against a single implementation. `envelope` is what really
  // delivers the narrowing, by parsing the scripted text against that schema.
  const run = async (subagent: SubagentDef, options: DelegateOptions): Promise<DelegateResult> => {
    const call: StubDelegateCall = { subagent, task: options.task, options };
    calls.push(call);
    const route = routes ? routes[subagent.name] : single;
    if (route === undefined) {
      throw new Error(
        `stubDelegate: no route for subagent ${JSON.stringify(subagent.name)}. ` +
          `Routed subagents: ${Object.keys(routes ?? {}).join(", ") || "(none)"}.`,
      );
    }
    return await envelope(subagent, typeof route === "function" ? route(call) : route);
  };

  return { delegate: run as DelegateFn, calls };
}

/** A fake `stepDelegate`: the calls it recorded, and the slot to give back. */
export interface StubStepDelegate {
  /** Every call, in order — the same log {@link stubDelegate} keeps. */
  calls: StubDelegateCall[];
  /**
   * Unpublish the runner.
   *
   * Calling it in an `afterEach` is not optional — a stub left published makes
   * the next file's steps delegate into this one's log, which is the kind of
   * cross-file leak that presents as a passing test somewhere else.
   */
  restore(): void;
}

/**
 * PUBLISH a fake runner, so an exported step that calls `stepDelegate` can be
 * driven without a host.
 *
 * `stubDelegate` with the slot filled in, and deliberately nothing more: the
 * step-side and tool-side capabilities have the same signature because they are
 * the same runner bound differently, so a spec routes them the same way and a
 * template that moves a subagent from a tool into a step rewrites no fake.
 *
 * An unpublished slot THROWS rather than degrading (see `sdk/step-delegate.ts`),
 * which is what makes this the ONE way to test such a step — and why the failure
 * an author meets first names this function.
 *
 * @example
 * ```ts
 * import { stubStepDelegate } from "@alexkroman1/aai/testing";
 *
 * const desk = stubStepDelegate({ routes: { researcher: "Prices fell 12% in 2025." } });
 * try {
 *   // … call the exported step, then assert on `desk.calls`
 * } finally {
 *   desk.restore();
 * }
 * ```
 *
 * @public
 */
export function stubStepDelegate(script: StubDelegateScript): StubStepDelegate {
  const { delegate, calls } = stubDelegate(script);
  publishStepDelegate(delegate);
  return { calls, restore: () => publishStepDelegate(undefined) };
}

/**
 * The route table a script names, or `undefined` for a `{ reply }` script — and
 * a throw for anything that is neither, which is what a script in the bare
 * shape this used to take reaches when nothing type-checked it.
 */
function routeTable(
  script: StubDelegateScript,
): Readonly<Record<string, StubDelegateRoute>> | undefined {
  const given: unknown = script;
  if (isRecord(given) && "reply" in given !== "routes" in given) {
    return "routes" in script ? script.routes : undefined;
  }
  throw new Error(
    "stubDelegate: a script is `{ reply }` (one route for every delegation) or `{ routes }` " +
      "(keyed by subagent name), exactly one of the two",
  );
}

/** The full {@link DelegateResult} a route's shorthand stands for. */
/**
 * Parse the scripted text against the subagent's schema, when it declares one.
 *
 * A spec driving a schema-declaring subagent gets the same `object` the real
 * runner would build — so a fake whose script does not match the shape fails in
 * the spec rather than passing and leaving the tool under test to read
 * `undefined`. The failure names the subagent, because a route table's
 * scripted reply is several lines from where it is read.
 */
async function typedObject(sub: SubagentDef, text: string): Promise<{ object: unknown } | object> {
  if (!sub.schema) return {};
  const parsed = safeJsonParse(stripJsonFence(text));
  const result = await sub.schema["~standard"].validate(parsed);
  if (result.issues) {
    throw new Error(
      `stubDelegate: the scripted reply for subagent ${JSON.stringify(sub.name)} does not match its schema: ${formatSchemaIssues(result.issues)}`,
    );
  }
  return { object: result.value };
}

async function envelope(sub: SubagentDef, reply: StubDelegateReply): Promise<DelegateResult> {
  if (typeof reply === "string") {
    return {
      text: reply,
      steps: 1,
      toolCalls: [],
      revisions: 0,
      accepted: true,
      ...(await typedObject(sub, reply)),
    };
  }
  const toolCalls = reply.toolCalls ?? [];
  return {
    ...(await typedObject(sub, reply.text)),
    text: reply.text,
    // `steps` defaults to one MORE than the tool calls, not to zero: a run that
    // called two tools took at least three steps, and a spec reading `steps` off
    // a fake that said `0` would assert a run that never happened.
    steps: reply.steps ?? toolCalls.length + 1,
    toolCalls,
    revisions: reply.revisions ?? 0,
    // A staged complaint IS the rejection — see `StubDelegateReply.complaint`.
    // The `accepted` flag reads the same field the spread omits, which is why
    // the two lines look like they duplicate a guard and do not.
    accepted: reply.complaint === undefined,
    ...omitUndefined({ complaint: reply.complaint }),
  };
}
