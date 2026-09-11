// Copyright 2026 the AAI authors. MIT license.
// One session's WIRING — the tool surface it assembles, what it announces, and
// the one event that wakes the slow tier. UNIT tier: the slow loop is a seam
// the spec fills, so nothing here opens a socket or reads a clock.
//
// `session.integration.test.ts` composes the same bridge with the gate and the
// channel and drives a whole exchange through it; this file pins the wiring.

import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { tick } from "../_test-utils.ts";
import { consoleLogger } from "../runtime-config.ts";
import { ASK_USER, STATE_SUMMARY_ARG, TASK_DONE, TELL_USER } from "./channel.ts";
import { type ResolvedTwoTier, resolveTwoTier } from "./resolve.ts";
import { openTwoTierSession, type TwoTierSession } from "./session.ts";
import type { SlowTierView } from "./view.ts";

const CONFIG = resolveTwoTier({}) as ResolvedTwoTier;

const SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    name: "look_up",
    description: "Read something",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    type: "function",
    name: "change_address",
    description: "Change an address",
    parameters: { type: "object", properties: {} },
    mutates: true,
  },
];

function open(over: { agentSchemas?: ToolSchema[] } = {}): {
  session: TwoTierSession;
  views: SlowTierView[];
} {
  const views: SlowTierView[] = [];
  const session = openTwoTierSession({
    config: CONFIG,
    agentSchemas: over.agentSchemas ?? SCHEMAS,
    instructions: () => "You are the desk.",
    transport: () => ({}),
    runTool: () => Promise.resolve("{}"),
    slowLoop: () => (view) => {
      views.push(view);
      return Promise.resolve("completed");
    },
    logger: consoleLogger,
    sessionId: "s1",
  });
  return { session, views };
}

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

describe("the slow tier's tool surface", () => {
  test("is the agent's tools plus the three channel ones, every schema requiring the digest", () => {
    const { session } = open();
    expect(session.schemas.map((s) => s.name)).toEqual([
      "look_up",
      "change_address",
      TELL_USER,
      ASK_USER,
      TASK_DONE,
    ]);
    for (const schema of session.schemas) {
      expect(schema.parameters.required).toContain(STATE_SUMMARY_ARG);
    }
  });

  test("the agent's own schemas are NOT mutated", () => {
    const before = structuredClone(SCHEMAS);
    open();
    expect(SCHEMAS).toEqual(before);
  });

  test("an agent with no tools still gets the channel", () => {
    const { session } = open({ agentSchemas: [] });
    expect(session.schemas.map((s) => s.name)).toEqual([TELL_USER, ASK_USER, TASK_DONE]);
  });
});

describe("what it announces", () => {
  test("the AGENT's undeclared tools, once, and nothing of its own", () => {
    // Absence cannot be told from "read-only" by the gate, so an author who
    // forgot `mutates: true` finds out from a line rather than from a
    // benchmark. Two bugs in the first draft put the framework's own three
    // tools in this warning and in a second one beside it — and a warning about
    // the framework is how a reader learns to stop reading the log.
    const warn = vi.spyOn(consoleLogger, "warn");
    open();
    const undeclared = warn.mock.calls.filter(([m]) => String(m).includes("no `mutates`"));
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]?.[1]).toMatchObject({ sid: "s1", tools: ["look_up"] });
    expect(warn.mock.calls.find(([m]) => String(m).includes("state_summary"))).toBeUndefined();
  });

  test("nothing at all when every tool is declared", () => {
    const warn = vi.spyOn(consoleLogger, "warn");
    open({ agentSchemas: [{ ...SCHEMAS[0], mutates: false }, SCHEMAS[1]] as ToolSchema[] });
    expect(warn.mock.calls.filter(([m]) => String(m).includes("no `mutates`"))).toEqual([]);
  });
});

describe("the prompt section", () => {
  test("is EMPTY before anything happens, so the prompt is byte-identical", () => {
    // Load-bearing: `SessionSystemPrompt.resolve` hands back the base string
    // itself for an empty suffix, which is what makes the on-arm before the
    // first tool call comparable to the off-arm at all.
    expect(open().session.promptSection()).toBe("");
  });
});

describe("the wake", () => {
  test("a committed CALLER utterance runs the slow tier over the conversation", async () => {
    const h = open();
    h.session.observe(said("Change my address."));
    await vi.waitFor(() => expect(h.views).toHaveLength(1));
    expect(h.views[0]?.conversation).toEqual([{ role: "user", content: "Change my address." }]);
    expect(h.views[0]?.instructions).toBe("You are the desk.");
    expect(h.views[0]?.catalog.map((t) => t.name)).toEqual(["look_up", "change_address"]);
  });

  test("the AGENT's own words are recorded and wake nothing", async () => {
    // Waking on them would run the slow tier against its own narration —
    // including the turn `injectTurn` just caused, which is a loop.
    const h = open();
    h.session.observe(agentSaid("One moment."));
    await tick();
    expect(h.views).toHaveLength(0);
  });

  test("an unrelated event wakes nothing and records nothing", async () => {
    const h = open();
    h.session.observe({ type: "speech.started", meta: META } as SessionEvent);
    await tick();
    expect(h.views).toHaveLength(0);
  });

  test("the slow tier's own CATALOGUE excludes the channel tools", async () => {
    // The view is built from the AGENT's schemas, not the wrapped set: the
    // channel is how the slow tier talks, not something to reason about.
    const h = open();
    h.session.observe(said("hello"));
    await vi.waitFor(() => expect(h.views).toHaveLength(1));
    expect(h.views[0]?.catalog.map((t) => t.name)).not.toContain(TELL_USER);
  });

  test("stop() keeps a later utterance from running anything", async () => {
    const h = open();
    h.session.stop();
    h.session.observe(said("hello"));
    await tick();
    await tick();
    expect(h.views).toHaveLength(0);
  });
});
