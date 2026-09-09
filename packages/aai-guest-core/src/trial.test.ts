// Copyright 2026 the AAI authors. MIT license.
/**
 * A one-shot tool trial: `executeTool` and `runCode`.
 *
 * Split out of `aai-guest/src/harness.test.ts` when this module moved into
 * `aai-guest-core`: coverage attributes a file to whoever LOADS it, so a
 * module whose only tests live in a dependent package reads as uncovered in
 * its own — which seeds a floor that cannot fail. A test follows its subject.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { rejectAllPendingHostRequests, setHostSend } from "./rpc.ts";
import {
  type FakeHostChannel,
  installFakeHostChannel,
  makeAgent,
  TRIAL_OPTS,
} from "./test-utils.ts";
import { executeTool, runCode } from "./trial.ts";

let host: FakeHostChannel;
let sent: FakeHostChannel["sent"];

beforeEach(() => {
  host = installFakeHostChannel();
  sent = host.sent;
});

afterEach(() => {
  rejectAllPendingHostRequests("test teardown");
  setHostSend(null);
});

describe("executeTool (one-shot trial)", () => {
  test("runs a tool and returns result + state", async () => {
    const res = await executeTool(
      makeAgent(),
      { name: "echo", args: { text: "hi" }, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res).toEqual({ result: "echo:hi", state: {} });
  });

  test("initializes state from the agent factory when state is null", async () => {
    const agent = makeAgent({ state: () => ({ count: 10 }) });
    const res = await executeTool(
      agent,
      { name: "mutate", args: {}, sessionId: "s1", state: null },
      TRIAL_OPTS,
    );
    expect(res.result).toBe("count=11");
    expect(res.state).toEqual({ count: 11 });
  });

  test("mutations to shipped state ride back on the response", async () => {
    const res = await executeTool(
      makeAgent(),
      { name: "mutate", args: {}, sessionId: "s1", state: { count: 5 } },
      TRIAL_OPTS,
    );
    expect(res.state).toEqual({ count: 6 });
  });

  test("a throwing tool returns error AND state", async () => {
    const res = await executeTool(
      makeAgent(),
      { name: "explode", args: {}, sessionId: "s1", state: { seen: true } },
      TRIAL_OPTS,
    );
    expect(res.error).toBe("kaboom");
    expect(res.state).toEqual({ seen: true });
  });

  test("unknown tool returns an error, not a throw", async () => {
    const res = await executeTool(
      makeAgent(),
      { name: "nope", args: {}, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res.error).toBe("Unknown tool: nope");
  });

  test("invalid args surface as a tool error the LLM can repair", async () => {
    const agent = makeAgent({
      tools: {
        strict: {
          description: "strict params",
          parameters: {
            parse: () => {
              throw new Error("bad args");
            },
          },
          execute: () => "never",
        },
      },
    });
    const res = await executeTool(
      agent,
      { name: "strict", args: { wrong: true }, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res.error).toBe("bad args");
  });

  test("run_code executes in the guest and captures console output", async () => {
    const res = await executeTool(
      makeAgent(),
      {
        name: "run_code",
        args: { code: "console.log('a', 1); console.log(2)" },
        sessionId: "s1",
        state: {},
      },
      TRIAL_OPTS,
    );
    expect(res.result).toBe("a 1\n2");
  });

  test("run_code reports thrown errors", async () => {
    const res = await executeTool(
      makeAgent(),
      { name: "run_code", args: { code: "throw new Error('nope')" }, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res.error).toBe("nope");
  });

  // The wedge: an async IIFE runs synchronously to its first `await`, and code
  // with no `await` never yields — so the in-thread timer that was supposed to
  // stop it could not be reached to fire, and the guest burned to Modal's
  // lifetime cap with `/health` unanswered.
  test("run_code terminates code that never yields, instead of wedging the guest", async () => {
    const res = await runCode("while (true) {}", 250);
    expect(res).toMatchObject({ error: expect.stringContaining("timed out") });
    // A promise race would have "returned" here too — and left the loop running.
    // The proof that the thread is gone is that the next call still answers.
    // (A wall-clock `Date.now()` bound used to sit here as well. It asserted
    // nothing this line does not: a surviving spin loop starves the pool and
    // the second call never resolves, which the suite timeout reports. What it
    // added was a failure mode of its own on a loaded runner.)
    expect(await runCode("console.log('still alive')", 5000)).toBe("still alive");
  });

  test("run_code output survives the hop back from the worker", async () => {
    expect(await runCode("console.log({ a: 1 }); console.error('and stderr')")).toBe(
      "[object Object]\nand stderr",
    );
  });

  test("a tool reaching for ctx.db fails, because the field does not exist", async () => {
    // This used to assert a curated "no database is configured" message. `ctx.db`
    // is gone entirely — the platform hands tool code no database — so what a tool
    // written against the old API gets is a TypeError. Asserted rather than
    // deleted: failing LOUDLY is the contract, not reading `undefined` and moving
    // on.
    const agent = makeAgent({
      tools: {
        usesDb: {
          description: "touch ctx.db",
          execute: (_args, ctx) => {
            const reached = (ctx as { db?: { query(s: string): Promise<unknown> } }).db;
            // No non-null assertion: the point is that the field is ABSENT, and a
            // `!` would assert the opposite of what this spec claims.
            if (!reached) throw new Error("ctx.db is gone");
            return reached.query("select 1");
          },
        },
      },
    });
    const res = await executeTool(
      agent,
      { name: "usesDb", args: {}, sessionId: "s1", state: {} },
      TRIAL_OPTS,
    );
    expect(res.error).toBeTruthy();
  });

  test("ctx.env carries the loaded env into tool code", async () => {
    const agent = makeAgent({
      tools: {
        readsEnv: {
          description: "reads env",
          execute: (_args, ctx) => `who=${ctx.env.WHO}`,
        },
      },
    });
    const res = await executeTool(
      agent,
      { name: "readsEnv", args: {}, sessionId: "s1", state: {} },
      { env: Object.freeze({ WHO: "world" }) },
    );
    expect(res.result).toBe("who=world");
  });

  test("ctx.send is a silent no-op in trial runs (no connected client)", async () => {
    const agent = makeAgent({
      tools: {
        notifies: {
          description: "sends to client",
          execute: (_args, ctx) => {
            ctx.send("evt", { x: 1 });
            return "sent";
          },
        },
      },
    });
    const res = await executeTool(
      agent,
      { name: "notifies", args: {}, sessionId: "s9", state: {} },
      TRIAL_OPTS,
    );
    expect(res.result).toBe("sent");
    expect(sent).toEqual([]);
  });
});
