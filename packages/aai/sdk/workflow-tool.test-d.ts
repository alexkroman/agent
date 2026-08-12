// Copyright 2026 the AAI authors. MIT license.
/**
 * `startTool`'s inference, pinned at the type level.
 *
 * This exists because the property it guards regressed silently once and cannot
 * be seen by a runtime test: written as two overloads, `startTool` typed every
 * `input` mapper parameter as implicitly `any`. The suite stayed green — an `any`
 * argument satisfies every assertion — while the mapper, the one function in the
 * helper doing real work, lost its types entirely. `noImplicitAny` catches it only
 * in a package that compiles the call, which is what these assertions stand in for.
 */

import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { InferToolInput, ToolDef } from "./types.ts";
import { workflow } from "./workflow.ts";
import { type DerivedStartToolOptions, startTool } from "./workflow-tool.ts";

/**
 * Named separately from the workflow because `WorkflowDef.input` is OPTIONAL, so
 * `typeof digest.input` includes `undefined` and cannot satisfy `ToolInputSchema`
 * where these assertions need it as a type argument.
 */
const digestInput = z.object({ topic: z.string(), depth: z.number() });

const digest = workflow({
  input: digestInput,
  run: ({ topic, depth }) => ({ topic, depth }),
});

const brief = z.object({ id: z.string() });

/** What the workflow's own `run` receives. */
type RunInput = { topic: string; depth: number };

test("the plain form takes the workflow's own schema", () => {
  const started = startTool(digest, { description: "d" });
  expectTypeOf(started).toEqualTypeOf<ToolDef<typeof digestInput>>();
  expectTypeOf<InferToolInput<typeof started>>().toEqualTypeOf<RunInput>();
});

test("the derived form types the tool by its own schema, not by the workflow", () => {
  const started = startTool(digest, {
    description: "d",
    inputSchema: brief,
    input: ({ id }) => ({ topic: id, depth: 1 }),
  });
  expectTypeOf(started).toEqualTypeOf<ToolDef<typeof brief>>();
  expectTypeOf<InferToolInput<typeof started>>().toEqualTypeOf<{ id: string }>();
});

test("the mapper's argument is inferred from inputSchema", () => {
  // THE regression this file exists for. Under overloads `args` was `any`, and
  // nothing anywhere said so.
  startTool(digest, {
    description: "d",
    inputSchema: brief,
    input: (args) => {
      expectTypeOf(args).toEqualTypeOf<{ id: string }>();
      expectTypeOf(args.id).toEqualTypeOf<string>();
      return { topic: args.id, depth: 0 };
    },
  });
});

test("the mapper is declared to return the workflow's own input shape", () => {
  // Asserted on the DECLARED signature rather than by compiling a wrong mapper
  // under a suppression, which is what `pnpm check:hatches` ratchets down. The
  // positive form says the same thing: a mapper returning less cannot satisfy it.
  type Mapper = DerivedStartToolOptions<typeof brief, typeof digestInput>["input"];
  expectTypeOf<ReturnType<Mapper>>().toEqualTypeOf<RunInput | Promise<RunInput>>();
  expectTypeOf<Parameters<Mapper>[0]>().toEqualTypeOf<{ id: string }>();
});

test("an async mapper is accepted", () => {
  startTool(digest, {
    description: "d",
    inputSchema: brief,
    input: ({ id }) => Promise.resolve({ topic: id, depth: 2 }),
  });
});
