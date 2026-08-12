// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-user scoping — the three postures, and that a scoped caller cannot reach
 * another user's run.
 *
 * Driven through the ENGINE against the in-memory journal rather than through the
 * SQL, because what has to hold is a property of the whole path: a scope is stamped
 * at `start` and every read and mutation filters on it. The store's own specs pin
 * the SQL; `workflow-api.test.ts` pins which scope the API asks for.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { workflow } from "../sdk/workflow.ts";
import { drain, makeEngine } from "./_workflow-engine-harness.ts";

beforeEach(() => {
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

const noop = workflow({ input: z.object({}), run: () => "done" });

describe("owner scope", () => {
  test("a scoped caller sees only its own runs", async () => {
    const { engine } = makeEngine({ noop });
    const alice = engine.scoped("user:alice");
    const bob = engine.scoped("user:bob");

    const aliceRun = await alice.start(noop, {}, { key: "k" });
    await drain(20);

    // Alice reads her own run three ways.
    expect(await alice.get(aliceRun)).toBeDefined();
    expect(await alice.find(noop, "k")).toHaveLength(1);
    expect(await alice.recent(noop)).toHaveLength(1);

    // Bob sees none of it — not by id, not by key, not in the listing. `get`
    // answering undefined rather than throwing is deliberate: "no such run" and
    // "not yours" are the same answer, so the id leaks nothing.
    expect(await bob.get(aliceRun)).toBeUndefined();
    expect(await bob.find(noop, "k")).toEqual([]);
    expect(await bob.recent(noop)).toEqual([]);
  });

  test("a scoped caller cannot cancel or retry another's run", async () => {
    // The half that matters most: a read leak is bad and a WRITE leak lets one
    // user stop another's work.
    // A workflow that throws, so the run reaches `failed` on its own — `store.fail`
    // is refused once a run is terminal, which is what makes a completed one a bad
    // fixture here.
    const boom = workflow({
      input: z.object({}),
      run: (_input, ctx) =>
        ctx.step(
          "explode",
          () => {
            throw new Error("boom");
          },
          { maxAttempts: 1 },
        ),
    });
    const { engine } = makeEngine({ boom });
    const runId = await engine.scoped("user:alice").start(boom, {});
    await drain(30);

    expect((await engine.get(runId))?.status).toBe("failed");
    expect(await engine.scoped("user:bob").cancel(runId)).toBe(false);
    expect(await engine.scoped("user:bob").retry(runId)).toBe(false);
    expect((await engine.get(runId))?.status).toBe("failed");

    // Alice can.
    expect(await engine.scoped("user:alice").retry(runId)).toBe(true);
  });

  test("the OPERATOR (unscoped) sees every run, whoever owns it", async () => {
    // What `aai workflow runs` and the studio card need: `scoped(undefined)` is the
    // engine itself, which is also what an app declaring no identity gets.
    const { engine } = makeEngine({ noop });
    await engine.scoped("user:alice").start(noop, {});
    await engine.scoped("user:bob").start(noop, {});
    await drain(20);

    expect(await engine.recent(noop)).toHaveLength(2);
    expect(engine.scoped(undefined)).toBe(engine.scoped(undefined));
  });

  test("an UNSCOPED run is invisible to a scoped caller", async () => {
    // Runs created before an app declared `identify` belong to nobody. Handing one
    // to whichever user asks first is the leak the column exists to prevent, so the
    // scoped read does not match NULL.
    const { engine } = makeEngine({ noop });
    const legacy = await engine.start(noop, {});
    await drain(20);

    expect(await engine.get(legacy)).toBeDefined();
    expect(await engine.scoped("user:alice").get(legacy)).toBeUndefined();
  });

  test("a continuation inherits its predecessor's scope", async () => {
    // Otherwise continue-as-new would launder a run out of its owner's view — the
    // successor would belong to nobody and become readable by an unscoped caller
    // only, which is a silent ownership change mid-chain.
    const chain = workflow({
      input: z.object({ n: z.number() }),
      run: ({ n }, ctx) => (n > 0 ? ctx.continueAs({ n: n - 1 }) : "end"),
    });
    const { engine, store } = makeEngine({ chain });
    const first = await engine.scoped("user:alice").start(chain, { n: 1 });
    await drain(40);

    const alice = engine.scoped("user:alice");
    // Both links are Alice's: the predecessor, and the successor its output names.
    const predecessor = await alice.get(first);
    expect(predecessor?.status).toBe("completed");
    const successor = (predecessor as { output?: { continuedAs?: string } }).output?.continuedAs;
    expect(successor).toBeTypeOf("string");
    expect(await alice.get(successor as string)).toBeDefined();
    expect(await engine.scoped("user:bob").get(successor as string)).toBeUndefined();
    expect(store.row(successor as string).ownerScope).toBe("user:alice");
  });
});
