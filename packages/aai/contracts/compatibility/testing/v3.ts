// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `testing` epoch 3.
 *
 * **Nothing was added to this capability's own exports.** The epoch moved
 * because what `createStubWorkflows` COVERS widened: the client gained
 * `streamTail`, and the whole reason that helper exists is that it covers the
 * client rather than a snapshot of it. Epochs 1 and 2 still compile beside this
 * one (see `./v1.ts` and `./v2.ts`); this file asserts the new method is stubbed
 * and overridable like the rest, which is the promise a hand-written stub cannot
 * keep.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
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
