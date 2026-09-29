// Copyright 2026 the AAI authors. MIT license.
/**
 * `describeEval`'s `network`: one fake answering all three fetches a case can
 * reach, reset per case and per REPEAT.
 *
 * FORCED into stub mode, and into TWO repeats, at module scope — both are read
 * at collection time. The repeat is the point of half of this file: a
 * downstream suite's hand-rolled fake carried its request log and its rows from
 * one `AAI_EVAL_REPEAT` repeat into the next, so the second repeat asserted
 * against the first's traffic. Each case below asserts an EXACT count, which
 * is what a carried-over log would break on the second repeat — and counts its
 * own passes, because a repeat runner that passes a case failing SOME repeats
 * (it reports it UNSTABLE) would otherwise hide exactly that break.
 */

import { agent, tool, workflow } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { stepFetch } from "@alexkroman1/aai/step";
import { afterAll, expect, vi } from "vitest";
import { z } from "zod";
import { describeEval } from "./describe.ts";
import { toolResultIn } from "./events.ts";
import { evalNetwork } from "./network.ts";

vi.stubEnv("AAI_EVAL_STUB", "1");
vi.stubEnv("AAI_EVAL_REPEAT", "2");

/** Passes per case, checked once every repeat has run. */
const passes = new Map<string, number>();
const passed = (name: string): void => void passes.set(name, (passes.get(name) ?? 0) + 1);
afterAll(() => {
  // A throw rather than an `expect`: a hook is not a test, and Biome's
  // `noMisplacedAssertion` holds that line.
  const counts = [...passes.values()];
  if (counts.length !== 6 || counts.some((n) => n !== 2)) {
    throw new Error(
      `every case must pass BOTH repeats; passes: ${JSON.stringify(Object.fromEntries(passes))}`,
    );
  }
});

/** A custom tool: the GLOBAL fetch. */
const weather = tool({
  description: "Current temperature.",
  inputSchema: z.object({}),
  execute: async () => {
    const response = await fetch("https://api.open-meteo.com/v1/forecast?latitude=44.05");
    return await response.json();
  },
});

/** A custom tool reaching a host the network does not route. */
const placeCall = tool({
  description: "Place a phone call.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      await fetch("https://api.twilio.com/2010-04-01/Accounts/AC0/Calls.json", { method: "POST" });
      return { placed: true };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

/** A custom tool over a fake with STATE: POST a row, then count them. */
const addRow = tool({
  description: "Save a note and count the notes.",
  inputSchema: z.object({}),
  execute: async () => {
    await fetch("https://crm.example/rest/v1/notes", { method: "POST", body: "{}" });
    return await (await fetch("https://crm.example/rest/v1/notes")).json();
  },
});

/** A workflow whose step reaches the network through `stepFetch`. */
const notify = workflow({
  input: z.object({}),
  run: async () => {
    const response = await stepFetch("https://sms.example/send", { method: "POST", body: "hi" });
    return { status: response.status };
  },
});

const sendText = tool({
  description: "Text the owner.",
  inputSchema: z.object({}),
  execute: async (_args, ctx) => ({ runId: await ctx.workflows.start(notify, {}) }),
});

const def = withTools(
  agent({ name: "Network Suite", builtinTools: ["fetch_json"], workflows: { notify } }),
  { weather, place_call: placeCall, add_row: addRow, send_text: sendText },
);

/** One network for the suite — an INSTANCE, whose log must be reset per repeat. */
const shared = evalNetwork({
  routes: {
    "api.open-meteo.com": () => ({ temperature: 54.4 }),
    "rates.example": () => ({ usd: 1 }),
    "sms.example": () => undefined,
  },
});

/** One INSTANCE whose routes keep their rows in `state`, which each repeat's reset rebuilds. */
const notes = evalNetwork({
  state: () => ({ rows: [] as unknown[] }),
  routes: {
    "https://crm.example/rest/v1/notes": (request, _info, state) => {
      if (request.method === "POST") state.rows.push({});
      return request.method === "POST" ? undefined : { count: state.rows.length };
    },
  },
});

describeEval(
  def,
  (test) => {
    test(
      "a custom tool's global fetch is routed, and the log holds this repeat alone",
      async ({ session, network }) => {
        const turn = await session.say("how warm is it?");
        expect(toolResultIn(turn.toolCalls, "weather")).toEqual({ temperature: 54.4 });
        expect(network?.calls("api.open-meteo.com")).toHaveLength(1);
        passed("global");
      },
      { stubReply: [{ tool: "weather", args: {} }, "It's 54 degrees."] },
    );

    test(
      "a BUILTIN's fetch goes through the same network",
      async ({ session, network }) => {
        const turn = await session.say("what's the dollar rate?");
        expect(JSON.stringify(turn.toolCalls[0]?.result)).toContain("usd");
        expect(network?.calls("rates.example")).toHaveLength(1);
        passed("builtin");
      },
      {
        stubReply: [
          { tool: "fetch_json", args: { url: "https://rates.example/latest" } },
          "One to one.",
        ],
      },
    );

    test(
      "an unrouted host is refused, the tool sees the failure, and the log says so",
      async ({ session, network }) => {
        const turn = await session.say("call the restaurant");
        expect(JSON.stringify(toolResultIn(turn.toolCalls, "place_call"))).toMatch(/refused/);
        expect(network?.refused().map((r) => r.host)).toEqual(["api.twilio.com"]);
        expect(() => network?.expectNoOutbound(/twilio/)).toThrow(/1 were attempted/);
        passed("refused");
      },
      { stubReply: [{ tool: "place_call", args: {} }, "I couldn't place it."] },
    );

    test(
      "a workflow step's stepFetch is routed too",
      async ({ session, network, workflows }) => {
        await session.say("text me");
        const [run] = (await workflows?.settleAll()) ?? [];
        expect(run?.output).toEqual({ status: 204 });
        expect(network?.calls("sms.example").map((r) => r.text)).toEqual(["hi"]);
        passed("step");
      },
      { stubReply: [{ tool: "send_text", args: {} }, "Sent."] },
    );

    test(
      "a case's FACTORY is called per repeat, so a route's state starts fresh each time",
      async ({ session, network }) => {
        const turn = await session.say("save a note");
        // One POST, then a count of one — two on the second repeat if the rows
        // had carried over.
        expect(toolResultIn(turn.toolCalls, "add_row")).toEqual({ count: 1 });
        expect(network?.requests()).toHaveLength(2);
        expect(network).not.toBe(shared);
        passed("factory");
      },
      {
        stubReply: [{ tool: "add_row", args: {} }, "Saved."],
        network: () => {
          const rows: unknown[] = [];
          return evalNetwork({
            routes: {
              "https://crm.example/rest/v1/notes": (request) => {
                if (request.method === "POST") rows.push({});
                return request.method === "POST" ? undefined : { count: rows.length };
              },
            },
          });
        },
      },
    );
  },
  { network: shared },
);

describeEval(
  def,
  (test) => {
    test(
      "a suite INSTANCE with state starts every repeat with fresh state, read off ctx.network",
      async ({ session, network }) => {
        const turn = await session.say("save a note");
        expect(toolResultIn(turn.toolCalls, "add_row")).toEqual({ count: 1 });
        // Typed: no cast, no module-level `let` holding the rows.
        expect(network.state.rows).toEqual([{}]);
        passed("state");
      },
      { stubReply: [{ tool: "add_row", args: {} }, "Saved."] },
    );
  },
  { network: notes },
);
