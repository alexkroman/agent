// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 4.
 *
 * **Epoch 4 is a RIPPLE, not a change to this capability.** `WorkflowDef`
 * gained an optional `uploads` list — the property names that carry an upload id
 * rather than a value — and this capability's report mentions that type through
 * a public signature, so its hash moved while nothing an author writes here did.
 * `aai:workflow` epoch 5 is where that addition is demonstrated.
 *
 * So this file is epoch 3's example, re-frozen: what it proves is exactly
 * what a re-frozen epoch should prove — that the authoring shape still compiles
 * against current source. See `../agent/v3.ts` for what "frozen" obliges and why
 * the imports are relative.
 */

import { createStubWorkflows, createToolContext } from "../../../sdk/testing.ts";

/** Unstubbed, it rejects by name like every other method. */
export async function unstubbedTailRejects(): Promise<string> {
  try {
    await createStubWorkflows().streamTail("wrun_1");
    return "unexpectedly resolved";
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Driven, it is what lets a test cover both sides of the bounded-read branch. */
export async function exerciseBoundedRead(tail: number): Promise<string> {
  const workflows = createStubWorkflows({
    streamTail: async () => tail,
    stream: async () =>
      new ReadableStream<unknown>({
        start(controller) {
          controller.enqueue("Reading…");
          controller.close();
        },
      }),
  });
  const ctx = createToolContext({ workflows });
  if ((await ctx.workflows.streamTail("wrun_1")) < 0) return "nothing yet";
  const stream = await ctx.workflows.stream("wrun_1", { startIndex: -1 });
  for await (const chunk of stream) return String(chunk);
  return "nothing yet";
}
