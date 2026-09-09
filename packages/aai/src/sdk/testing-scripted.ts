// Copyright 2026 the AAI authors. MIT license.
/**
 * A tool context with BOTH of its model seams scripted, in one call.
 *
 * A tool that reasons — a triage, a planner, a coordinator — reaches a model two
 * ways: `ctx.generate` for a prompt with an answer, and `ctx.delegate` for a
 * subagent's whole loop. `stubGenerate` and `stubDelegate` fake one each, and
 * every spec of such a tool then wrote the same third step: build both, then
 * `createToolContext({ generate: model.generate, delegate: desk.delegate })`,
 * and return `{ ctx, model, desk }` so the assertions can read what each was
 * asked. Three templates had that function; one rebuilt the context twelve
 * times because its helper returned the two functions instead of the context.
 *
 * What is NOT here is the routes table. Which system prompts a template's tools
 * carry and what each subagent should answer are the spec's whole content, and
 * a helper that took them by name would be a second copy of the template's
 * prompts module.
 *
 * @module testing-scripted
 */

import {
  createToolContext,
  type TestToolContext,
  type ToolContextOverrides,
} from "./_testing-context.ts";
import { type StubDelegate, type StubDelegateRoute, stubDelegate } from "./testing-delegate.ts";
import { type StubGenerate, type StubGenerateScript, stubGenerate } from "./testing-generate.ts";

/**
 * What {@link scriptedToolContext} takes: `stubGenerate`'s script as
 * `generate`, `stubDelegate`'s as `delegate`, and any other field of the
 * context — `sessionId`, `env`, `workflows` — as `createToolContext` takes it.
 *
 * Either script may be omitted: the fake is still built, so `model.calls` and
 * `desk.calls` are always there to assert on, and a call it was not scripted
 * for rejects naming the route it lacked — which is a spec that drifted from
 * its tool, not a case to paper over.
 *
 * An intersection ALIAS rather than an `interface extends`, because TypeDoc
 * renders an interface's inherited members with their ORIGINAL doc comments —
 * `ToolContext`'s, whose `{@link}`s resolve on the root entry and not on this
 * one, which failed the docs build as three unresolved links.
 *
 * @public
 */
export type ScriptedToolContextOptions = Omit<ToolContextOverrides, "generate" | "delegate"> & {
  /**
   * The script `stubGenerate` takes — routes keyed by system prompt, or one
   * route. Named through {@link StubGenerateScript} rather than restated, so the
   * `{ text }`-only misuse arm that type refuses is refused here too.
   */
  generate?: StubGenerateScript | undefined;
  /** The script `stubDelegate` takes — routes keyed by subagent name, or one route. */
  delegate?: Readonly<Record<string, StubDelegateRoute>> | StubDelegateRoute | undefined;
};

/**
 * What {@link scriptedToolContext} answers: the context to run tools against,
 * and the two fakes it was built from, for asserting what each was asked.
 *
 * @public
 */
export interface ScriptedToolContext {
  /** Pass to `runTool`/`toolRunner`, or straight to a tool's `execute`. */
  ctx: TestToolContext;
  /** The `ctx.generate` fake — `model.calls` is every prompt the tools sent. */
  model: StubGenerate;
  /** The `ctx.delegate` fake — `desk.calls` is every subagent run the tools asked for. */
  desk: StubDelegate;
}

/**
 * Build a {@link TestToolContext} whose `generate` and `delegate` are both
 * scripted, and hand back the fakes beside it.
 *
 * **`createToolContext` is the way in now.** Its `generate` and `delegate` take
 * the same scripts and expose the same fakes on the context (`ctx.model`,
 * `ctx.desk`), so one call covers scripting either seam, both, or neither. This
 * stays for the spec that reads the two fakes by name — `const { ctx, model,
 * desk } = scriptedToolContext(…)` — and for the one script shape the context's
 * own field cannot express, a top-level function route.
 *
 * Each call is a distinct session, as with `createToolContext`. A spec that
 * wants two sessions sharing one script calls this twice with the same routes
 * object — the routes are read at call time, so a function route with its own
 * queue is shared and a fixed route is not affected either way.
 *
 * @example
 * ```ts
 * import { scriptedToolContext } from "@alexkroman1/aai/testing";
 *
 * const TRIAGE = "You triage email.";
 * const { ctx, model, desk } = scriptedToolContext({
 *   generate: { [TRIAGE]: { object: { response: "email" } } },
 *   delegate: { "meeting-assistant": "Free Wednesday 1pm." },
 * });
 * // … run the tool against `ctx`, then:
 * // expect(model.calls.map((call) => call.system)).toEqual([TRIAGE]);
 * // expect(desk.calls[0]?.subagent.name).toBe("meeting-assistant");
 * ```
 *
 * @public
 */
export function scriptedToolContext(options: ScriptedToolContextOptions = {}): ScriptedToolContext {
  const { generate, delegate, ...overrides } = options;
  // `{}` is a route table with no routes: every call rejects naming "(none)",
  // which is `createToolContext`'s own default said more usefully — and the
  // fake still records the call.
  const model = stubGenerate(generate ?? {});
  const desk = stubDelegate(delegate ?? {});
  // Both halves of each seam: the FUNCTION to install, and the fake to expose as
  // `ctx.model`/`ctx.desk`. Passing the script down instead would be shorter and
  // would lose one thing — this signature also accepts a TOP-LEVEL FUNCTION
  // route, which `createToolContext` cannot tell from a real `ctx.generate`, so
  // the fake is built here and named there.
  const ctx = createToolContext({
    ...overrides,
    generate: model.generate,
    delegate: desk.delegate,
    model,
    desk,
  });
  return { ctx, model, desk };
}
