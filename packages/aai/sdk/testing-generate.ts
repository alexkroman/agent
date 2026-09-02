// Copyright 2026 the AAI authors. MIT license.
/**
 * A fake `ctx.generate`, for testing a tool body that calls a model.
 *
 * The tool-side twin of {@link stubGateway}, which fakes the same thing for a
 * step. Nothing covered this side, so a template whose tools reason
 * with a model wrote its own — and the two that did wrote the same two
 * non-obvious things.
 *
 * **The envelope is one of them.** `GenerateFn` is an overloaded type whose
 * schema arm declares `object` as REQUIRED, so a hand-written fake with a
 * `{ text }`-only branch is not assignable at all — not on that branch, on the
 * whole function. Both templates carried a comment explaining that to the next
 * reader, which is a fair sign the type is not one to satisfy by hand.
 *
 * **Routing by SYSTEM PROMPT is the other.** A tool that calls a model more than
 * once is really calling several different ones — a grader, a rewriter, an
 * answerer — and what tells them apart at the seam is `options.system`. So a
 * script keyed by the system constant reads as the set of model roles the tool
 * has, and an unrouted call fails NAMING the system it carried, rather than
 * quietly returning whatever the single stub was set to. That last part is the
 * whole value: a stub that answers everything can only ever drive a
 * multi-call tool through one path.
 */

import type { GenerateFn, GenerateOptions } from "./generate.ts";
import { isRecord } from "./utils.ts";

/** One `ctx.generate` call, as recorded by {@link stubGenerate}. */
export interface StubGenerateCall {
  /** The user prompt — what the tool actually asked. */
  prompt: string;
  /** The system instruction, or `undefined` when the call carried none. */
  system: string | undefined;
  /** The whole options object, for asserting `llm`, `temperature`, `schema`, … */
  options: GenerateOptions;
}

/**
 * What one route answers with.
 *
 * A bare string is text (the schemaless shape); an object is structured output,
 * and its `text` defaults to the JSON the real host would have returned — a
 * schema call's `text` IS the stringified object, so a fake that left it empty
 * would differ from production in the one place a caller might read it.
 *
 * @public
 */
export type StubGenerateReply = string | { text?: string; object: unknown };

/**
 * How a route answers: a fixed reply, or a function of the call.
 *
 * The function form is what a route with a QUEUE needs — a grader asked once per
 * document, an executor asked once per turn — since it can shift its own script.
 *
 * @public
 */
export type StubGenerateRoute = StubGenerateReply | ((call: StubGenerateCall) => StubGenerateReply);

/** A fake `ctx.generate`: the function to pass, and what it was asked. */
export interface StubGenerate {
  /** Pass as `generate` to `createToolContext`. */
  generate: GenerateFn;
  /** Every call, in order. */
  calls: StubGenerateCall[];
}

/**
 * Build a fake `ctx.generate` from a script keyed by system prompt.
 *
 * A call whose system prompt names no route throws, naming it — an unscripted
 * model call is a spec that has drifted from the tool, not a case to paper over.
 * Pass a single route (not a record) to answer every call the same way, which is
 * what a one-model tool wants.
 *
 * @example Two model roles, one queue
 * ```ts
 * import { createToolContext, stubGenerate } from "@alexkroman1/aai/testing";
 *
 * const verdicts = ["yes", "no"];
 * const model = stubGenerate({
 *   "You grade documents.": () => ({ object: { score: verdicts.shift() ?? "yes" } }),
 *   "You answer questions.": "The documented answer.",
 * });
 * const ctx = createToolContext({ generate: model.generate });
 * // … run the tool, then assert on the roles it played:
 * // expect(model.calls.map((call) => call.system)).toEqual([…]);
 * ```
 *
 * @example One model role
 * ```ts
 * import { stubGenerate } from "@alexkroman1/aai/testing";
 *
 * const model = stubGenerate({ object: { steps: ["Only step"] } });
 * ```
 *
 * @public
 */
export function stubGenerate(
  script: Readonly<Record<string, StubGenerateRoute>> | StubGenerateRoute,
): StubGenerate {
  const calls: StubGenerateCall[] = [];
  const routes = isRouteTable(script) ? script : undefined;

  // Annotated rather than inferred, and the implementation returns `object` on
  // every path: that is what makes one function inhabit both of `GenerateFn`'s
  // overloads. See the module doc.
  const generate = ((options: GenerateOptions) => {
    const call: StubGenerateCall = { prompt: options.prompt, system: options.system, options };
    calls.push(call);
    const route = routes ? routes[options.system ?? ""] : (script as StubGenerateRoute);
    if (route === undefined) {
      // REJECTS rather than throws: `ctx.generate` returns a promise, so a
      // synchronous throw would surface in a different place from every real
      // failure — and a tool that catches its own model errors would not catch
      // this one.
      return Promise.reject(
        new Error(
          `stubGenerate: no route for this call's system prompt. It carried: ${
            options.system === undefined ? "(none)" : JSON.stringify(options.system)
          }. Routed systems: ${
            Object.keys(routes ?? {})
              .map(shorten)
              .join(", ") || "(none)"
          }.`,
        ),
      );
    }
    return Promise.resolve(envelope(typeof route === "function" ? route(call) : route));
  }) as GenerateFn;

  return { generate, calls };
}

/**
 * Is this a table of routes, or one route?
 *
 * A single-route `{ object: … }` is an object too, so the two are told apart by
 * the reply shape rather than by `typeof` — which is also why `StubGenerateReply`
 * requires `object` rather than allowing `{ text }` alone: a bare `{ text }`
 * would be indistinguishable from a table with one route named `text`.
 */
function isRouteTable(
  script: Readonly<Record<string, StubGenerateRoute>> | StubGenerateRoute,
): script is Readonly<Record<string, StubGenerateRoute>> {
  return isRecord(script) && !("object" in script);
}

/** The `{ text, object }` shape both `GenerateFn` overloads are satisfied by. */
function envelope(reply: StubGenerateReply): { text: string; object: unknown } {
  if (typeof reply === "string") return { text: reply, object: null };
  return { text: reply.text ?? JSON.stringify(reply.object), object: reply.object };
}

/** A system prompt is a paragraph; an error listing several needs its first line. */
function shorten(system: string): string {
  const firstLine = system.split("\n", 1)[0] ?? "";
  return JSON.stringify(firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine);
}
