// Copyright 2026 the AAI authors. MIT license.
// The two-tier HANDOFF, end to end in memory.
//
// INTEGRATION tier (`*.integration.test.ts`): several modules composed — the
// digest, the gated tool surface, the channel, the coalescing runner and the
// prompt section — and nothing outside this process. No filesystem, no
// subprocess, no network, and no model: the slow "loop" here is a function the
// spec supplies, which is exactly the seam `openTwoTierSession` takes so that
// the bridge's behaviour can be stated without a provider.

import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { tick } from "../_test-utils.ts";
import { consoleLogger } from "../runtime-config.ts";
import { ASK_USER, STATE_SUMMARY_ARG, TASK_DONE, TELL_USER } from "./channel.ts";
import type { ResolvedTwoTier } from "./resolve.ts";
import { resolveTwoTier } from "./resolve.ts";
import { openTwoTierSession, type TwoTierSession } from "./session.ts";
import type { SlowRunOutcome } from "./slow-loop.ts";
import type { SlowTierView } from "./view.ts";

const CONFIG = resolveTwoTier({}) as ResolvedTwoTier;

const AGENT_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    name: "look_up_order",
    description: "Read an order",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    type: "function",
    name: "change_address",
    description: "Change an order's shipping address",
    parameters: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    mutates: true,
  },
  {
    type: "function",
    name: "hand_off",
    description: "Transfer to a person",
    parameters: { type: "object", properties: {} },
    completes: true,
  },
];

type Harness = {
  session: TwoTierSession;
  injected: string[];
  calls: { name: string; args: Readonly<Record<string, unknown>> }[];
  /** What the slow loop was handed, one entry per run. */
  views: SlowTierView[];
  /** Resolve the run currently in flight. */
  finish: () => void;
};

function harness(
  opts: {
    config?: ResolvedTwoTier;
    /** Called inside the slow run, so a spec drives the tool surface from "inside". */
    body?: (session: TwoTierSession) => Promise<void>;
    runTool?: (name: string, args: Readonly<Record<string, unknown>>) => Promise<string>;
  } = {},
): Harness {
  const injected: string[] = [];
  const calls: { name: string; args: Readonly<Record<string, unknown>> }[] = [];
  const views: SlowTierView[] = [];
  let release: (() => void) | undefined;
  const harnessRef: { session?: TwoTierSession } = {};

  const session = openTwoTierSession({
    config: opts.config ?? CONFIG,
    agentSchemas: AGENT_SCHEMAS,
    instructions: () => "You are the orders desk.",
    transport: () => ({ injectTurn: (instruction) => injected.push(instruction) }),
    runTool: async (name, args) => {
      calls.push({ name, args });
      return opts.runTool ? await opts.runTool(name, args) : JSON.stringify({ ok: true });
    },
    slowLoop:
      () =>
      async (view): Promise<SlowRunOutcome> => {
        views.push(view);
        if (opts.body) await opts.body(harnessRef.session as TwoTierSession);
        if (opts.body === undefined) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return "completed";
      },
    logger: consoleLogger,
    sessionId: "s1",
  });
  harnessRef.session = session;
  return { session, injected, calls, views, finish: () => release?.() };
}

// `meta` is required on every `SessionEvent` and the bridge reads none of it —
// the emitter mints it. A fixed one keeps these helpers honest against the
// union rather than casting past it.
const META = { id: "e1", at: 0 } as const;
const said = (text: string): SessionEvent => ({
  type: "user-transcript.committed",
  meta: META,
  text,
});
const agentSaid = (text: string): SessionEvent => ({
  type: "agent-transcript.committed",
  meta: META,
  text,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("the slow tier's tool surface", () => {
  test("holds the agent's tools AND the three channel tools, every one requiring the digest", () => {
    const { session } = harness();
    expect(session.schemas.map((s) => s.name)).toEqual([
      "look_up_order",
      "change_address",
      "hand_off",
      TELL_USER,
      ASK_USER,
      TASK_DONE,
    ]);
    for (const schema of session.schemas) {
      expect(schema.parameters.required).toContain(STATE_SUMMARY_ARG);
    }
  });

  test("announces the AGENT's undeclared tools, and nothing of its own", () => {
    // Absence cannot be told from "read-only" by the gate, so an author who
    // forgot finds out from a line rather than from a benchmark. Two bugs in
    // the first draft put the framework's own three tools in this line and in
    // a second one beside it; a warning about the framework is how a reader
    // learns to stop reading the log.
    const warn = vi.spyOn(consoleLogger, "warn");
    harness();
    const undeclared = warn.mock.calls.find(([m]) => String(m).includes("no `mutates`"));
    expect(undeclared?.[1]).toMatchObject({ tools: ["look_up_order"] });
    expect(warn.mock.calls.find(([m]) => String(m).includes("state_summary"))).toBeUndefined();
  });
});

describe("the digest rides on every call", () => {
  test("the summary is taken from the arguments and stripped before the tool runs", () => {
    const h = harness();
    void h.session.executeTool(
      "look_up_order",
      { id: "o1", [STATE_SUMMARY_ARG]: "Reading order o1." },
      new AbortController().signal,
    );
    expect(h.calls[0]).toEqual({ name: "look_up_order", args: { id: "o1" } });
    expect(h.session.promptSection()).toContain("Reading order o1.");
  });

  test("a READ leaves no digest entry — only a mutating step is tracked", async () => {
    // SABER's finding is the reason: a deviation on a mutating step is what
    // costs the odds of success, so tracking every lookup would fill the fast
    // tier's prompt with the half that does not matter.
    const h = harness();
    await h.session.executeTool(
      "look_up_order",
      { id: "o1", [STATE_SUMMARY_ARG]: "Read it." },
      new AbortController().signal,
    );
    expect(h.session.digest().read().entries).toEqual([]);
  });

  test("a MUTATING call opens and settles an entry", async () => {
    const h = harness();
    await h.session.executeTool(
      "change_address",
      { to: "5 Elm St", [STATE_SUMMARY_ARG]: "Changing it." },
      new AbortController().signal,
    );
    expect(h.session.digest().read().entries).toMatchObject([
      { tool: "change_address", state: "done" },
    ]);
  });

  test("a THROWING tool still settles, so the gate cannot wedge", async () => {
    // The failure this prevents: a run abandoned mid-step leaves an entry
    // pending forever and every later hand-off refused with nothing able to
    // clear it.
    const h = harness({
      runTool: () => Promise.reject(new Error("the address service is down")),
    });
    await expect(
      h.session.executeTool(
        "change_address",
        { to: "x", [STATE_SUMMARY_ARG]: "Trying." },
        new AbortController().signal,
      ),
    ).rejects.toThrow("the address service is down");
    expect(h.session.digest().unsettled()).toEqual([]);
    expect(h.session.digest().read().entries).toMatchObject([
      { tool: "change_address", state: "failed", note: "the address service is down" },
    ]);
  });

  test("the summary is written BEFORE the call, so a failure still grounds the fast tier", async () => {
    const h = harness({ runTool: () => Promise.reject(new Error("down")) });
    await h.session
      .executeTool(
        "change_address",
        { to: "x", [STATE_SUMMARY_ARG]: "Attempting the change now." },
        new AbortController().signal,
      )
      .catch(() => undefined);
    expect(h.session.promptSection()).toContain("Attempting the change now.");
  });
});

describe("the channel", () => {
  test("tell_user reaches the caller through injectTurn, not a second channel", async () => {
    const h = harness();
    const result = await h.session.executeTool(
      TELL_USER,
      { text: "The address is being changed.", [STATE_SUMMARY_ARG]: "In progress." },
      new AbortController().signal,
    );
    expect(h.injected).toEqual([
      "Tell the customer, in your own words: The address is being changed.",
    ]);
    expect(JSON.parse(result)).toEqual({ delivered: true });
    // And it is NOT a tool call on the agent's own surface.
    expect(h.calls).toEqual([]);
  });

  test("ask_user is the same verb with a different instruction", async () => {
    const h = harness();
    await h.session.executeTool(
      ASK_USER,
      { question: "Which order?", [STATE_SUMMARY_ARG]: "Need the order." },
      new AbortController().signal,
    );
    expect(h.injected[0]).toMatch(/^Ask the customer, in your own words: Which order\?$/);
  });
});

describe("digest-gated completion", () => {
  test("task_done is REFUSED while a mutating call is outstanding", async () => {
    const signal = new AbortController().signal;
    let hold: (() => void) | undefined;
    const h = harness({
      runTool: () =>
        new Promise<string>((resolve) => {
          hold = () => resolve("{}");
        }),
    });
    // Start a mutation and leave it in flight.
    const pending = h.session.executeTool(
      "change_address",
      { to: "x", [STATE_SUMMARY_ARG]: "Changing." },
      signal,
    );
    expect(h.session.digest().unsettled()).toHaveLength(1);

    const refused = await h.session.executeTool(
      TASK_DONE,
      { result: "All set!", [STATE_SUMMARY_ARG]: "Claiming done." },
      signal,
    );
    expect(JSON.parse(refused).error).toContain("change_address is still outstanding");
    // Nothing was spoken: the caller never hears the false completion.
    expect(h.injected).toEqual([]);

    hold?.();
    await pending;
    const allowed = await h.session.executeTool(
      TASK_DONE,
      { result: "Address changed.", [STATE_SUMMARY_ARG]: "Done." },
      signal,
    );
    expect(JSON.parse(allowed)).toEqual({ delivered: true });
    expect(h.injected).toHaveLength(1);
  });

  test("an AUTHOR's `completes` tool is gated the same way, and is not run", async () => {
    const signal = new AbortController().signal;
    let hold: (() => void) | undefined;
    const h = harness({
      runTool: (name) =>
        name === "change_address"
          ? new Promise<string>((resolve) => {
              hold = () => resolve("{}");
            })
          : Promise.resolve("{}"),
    });
    const pending = h.session.executeTool(
      "change_address",
      { to: "x", [STATE_SUMMARY_ARG]: "Changing." },
      signal,
    );
    const refused = await h.session.executeTool(
      "hand_off",
      { [STATE_SUMMARY_ARG]: "Handing over." },
      signal,
    );
    expect(JSON.parse(refused).error).toContain("still outstanding");
    expect(h.calls.map((c) => c.name)).toEqual(["change_address"]);
    hold?.();
    await pending;
  });

  test("a refused hand-off does not itself become outstanding work", async () => {
    // Checked BEFORE the entry is opened — otherwise the first refusal would
    // make every later one refuse too.
    const signal = new AbortController().signal;
    let hold: (() => void) | undefined;
    const h = harness({
      runTool: (name) =>
        name === "change_address"
          ? new Promise<string>((resolve) => {
              hold = () => resolve("{}");
            })
          : Promise.resolve("{}"),
    });
    const pending = h.session.executeTool(
      "change_address",
      { to: "x", [STATE_SUMMARY_ARG]: "Changing." },
      signal,
    );
    await h.session.executeTool("hand_off", { [STATE_SUMMARY_ARG]: "x" }, signal);
    expect(
      h.session
        .digest()
        .unsettled()
        .map((e) => e.tool),
    ).toEqual(["change_address"]);
    hold?.();
    await pending;
  });

  test("with the gate OFF, the same call goes through", async () => {
    const signal = new AbortController().signal;
    let hold: (() => void) | undefined;
    const h = harness({
      config: resolveTwoTier({ completionGate: false }) as ResolvedTwoTier,
      runTool: () =>
        new Promise<string>((resolve) => {
          hold = () => resolve("{}");
        }),
    });
    const pending = h.session.executeTool(
      "change_address",
      { to: "x", [STATE_SUMMARY_ARG]: "Changing." },
      signal,
    );
    const allowed = await h.session.executeTool(TASK_DONE, { result: "done" }, signal);
    expect(JSON.parse(allowed)).toEqual({ delivered: true });
    hold?.();
    await pending;
  });
});

describe("the fast→slow channel is the session's own transcript", () => {
  test("a committed caller utterance wakes the slow tier", async () => {
    const h = harness();
    expect(h.views).toHaveLength(0);
    h.session.observe(said("Change my address to 5 Elm Street."));
    await vi.waitFor(() => expect(h.views).toHaveLength(1));
    expect(h.views[0]?.conversation).toEqual([
      { role: "user", content: "Change my address to 5 Elm Street." },
    ]);
    expect(h.views[0]?.instructions).toBe("You are the orders desk.");
    h.finish();
  });

  test("the agent's OWN words are recorded but wake nothing", async () => {
    // Waking on them would run the slow tier against its own narration —
    // including the turn `injectTurn` just caused, which is a loop.
    const h = harness();
    h.session.observe(agentSaid("Certainly, one moment."));
    await tick();
    expect(h.views).toHaveLength(0);
    h.session.observe(said("Thanks."));
    await vi.waitFor(() => expect(h.views).toHaveLength(1));
    expect(h.views[0]?.conversation).toEqual([
      { role: "assistant", content: "Certainly, one moment." },
      { role: "user", content: "Thanks." },
    ]);
    h.finish();
  });

  test("overlapping utterances COALESCE into one follow-up over the latest state", async () => {
    // A caller who says three things during one slow step gets one more run,
    // and it reads the whole conversation rather than carrying a payload.
    const h = harness();
    h.session.observe(said("one"));
    await vi.waitFor(() => expect(h.views).toHaveLength(1));
    h.session.observe(said("two"));
    h.session.observe(said("three"));
    expect(h.views).toHaveLength(1);
    h.finish();
    await vi.waitFor(() => expect(h.views).toHaveLength(2));
    expect(h.views[1]?.conversation.map((m) => m.content)).toEqual(["one", "two", "three"]);
    h.finish();
  });

  test("stop() keeps a later utterance from starting a run", async () => {
    const h = harness({ body: () => Promise.resolve() });
    h.session.stop();
    h.session.observe(said("hello"));
    await vi
      .waitFor(() => expect(h.views).toHaveLength(0), { timeout: 200 })
      .catch(() => undefined);
    expect(h.views).toHaveLength(0);
  });
});

describe("the digest reaches the fast tier through the prompt, with no extra model call", () => {
  test("nothing said yet renders NOTHING, so the prompt is unchanged", () => {
    expect(harness().session.promptSection()).toBe("");
  });

  test("the section states outstanding work and forbids claiming completion", async () => {
    const h = harness({
      body: async (session) => {
        await session.executeTool(
          "change_address",
          { to: "5 Elm St", [STATE_SUMMARY_ARG]: "Changing the address to 5 Elm St." },
          new AbortController().signal,
        );
      },
    });
    h.session.observe(said("Change it."));
    await vi.waitFor(() => expect(h.views).toHaveLength(1));
    const section = h.session.promptSection();
    expect(section).toContain("Changing the address to 5 Elm St.");
    expect(section).toContain("change_address: completed and confirmed");
    expect(section).toContain("Do not describe work as complete unless this status says it");
  });
});
