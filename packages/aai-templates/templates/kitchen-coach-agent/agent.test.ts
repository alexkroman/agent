import agentDef from "virtual:aai/agent";
import type { RouteHandler, RouteRequest } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import {
  createRouteContext,
  createToolContext,
  expectDeployable,
} from "@alexkroman1/aai-runtime/testing";
import { describeAgent } from "@alexkroman1/aai-runtime/testing/vitest";
import { describe, expect, test } from "vitest";
import { MAX_LISTED } from "./history.ts";
import {
  dueTimers,
  kitchenFrom,
  MAX_PANTRY_ITEMS,
  MAX_SERVINGS,
  MAX_TIMERS,
  spokenAmount,
  startTimer,
  type Timer,
  timeLeft,
} from "./shared.ts";
import getKitchen from "./tools/get_kitchen.ts";
import scaleAmount from "./tools/scale_amount.ts";
import startTimerTool from "./tools/start_timer.ts";

const NOW = Date.UTC(2026, 9, 27, 18);

/** A timer `minutes` from NOW, not yet rung. */
const timer = (id: string, minutes: number, rung = false): Timer => ({
  id,
  label: id,
  endsAt: NOW + minutes * 60_000,
  rung,
});

describeAgent(agentDef, (run) => {
  describe("the agent", () => {
    test("deploys with its three tools and the history route", () => {
      expect(expectDeployable(agentDef).name).toBe("Kitchen Coach");
      expect(Object.keys(agentDef.tools ?? {}).sort()).toEqual([
        "get_kitchen",
        "scale_amount",
        "start_timer",
      ]);
      expect(Object.keys(agentDef.routes ?? {})).toEqual(["GET /history"]);
    });

    test("the two kitchen tools are answered by the page, never by the server", async () => {
      // A clientTool's execute waits for the connected page; with no browser session to
      // bind (a spec, a text agent, a subagent) the call fails naming why.
      const ctx = createToolContext();
      await expect(run(getKitchen, ctx)).rejects.toThrow(/useClientTool/);
      await expect(run(startTimerTool, { label: "pasta", minutes: 9 }, ctx)).rejects.toThrow(
        /useClientTool/,
      );
    });
  });

  describe("get_kitchen's answer (kitchenFrom)", () => {
    test("is the form, tidied", () => {
      expect(
        kitchenFrom({
          cook: "  Sam ",
          servings: "4",
          diet: "vegetarian",
          pantry: "eggs, rice\n spinach \n\nEggs",
        }),
      ).toEqual({
        cook: "Sam",
        servings: 4,
        diet: "vegetarian",
        pantry: ["eggs", "rice", "spinach"],
      });
    });

    test("a blank or impossible field falls back rather than reaching the model", () => {
      const blank = kitchenFrom({ cook: "", servings: "", diet: "keto??", pantry: "" });
      expect(blank).toEqual({ cook: "", servings: 2, diet: "anything", pantry: [] });
      expect(kitchenFrom({ ...form(), servings: "40" }).servings).toBe(MAX_SERVINGS);
      expect(kitchenFrom({ ...form(), servings: "2.6" }).servings).toBe(3);
    });

    test("a long pantry is capped", () => {
      const many = Array.from({ length: MAX_PANTRY_ITEMS + 5 }, (_, i) => `item ${i}`).join("\n");
      expect(kitchenFrom({ ...form(), pantry: many }).pantry).toHaveLength(MAX_PANTRY_ITEMS);
    });
  });

  describe("start_timer's answer (startTimer)", () => {
    test("adds a timer and tells the model it started", () => {
      const { timers, result } = startTimer([], { label: " pasta ", minutes: 9 }, NOW, "t1");
      expect(result).toEqual({ started: true, label: "pasta", minutes: 9 });
      expect(timers).toEqual([{ id: "t1", label: "pasta", endsAt: NOW + 9 * 60_000, rung: false }]);
    });

    test("an unnamed timer is 'timer', and a rung one is dropped when the next starts", () => {
      const { timers } = startTimer([timer("old", -1, true)], { label: "", minutes: 1 }, NOW, "t2");
      expect(timers.map((t) => t.label)).toEqual(["timer"]);
    });

    test("refuses past the running cap, and says why", () => {
      const full = Array.from({ length: MAX_TIMERS }, (_, i) => timer(`t${i}`, 5));
      const { timers, result } = startTimer(full, { label: "rice", minutes: 18 }, NOW, "x");
      expect(result).toEqual({ error: expect.stringContaining(String(MAX_TIMERS)) });
      expect(timers).toEqual(full);
    });

    test("a timer rings once when it comes due, and counts down until then", () => {
      const timers = [timer("a", 0), timer("b", 4.1), timer("c", -1, true)];
      expect(dueTimers(timers, NOW).map((t) => t.id)).toEqual(["a"]);
      expect(timeLeft(timer("b", 4.1), NOW)).toBe("4:06");
      expect(timeLeft(timer("a", -1), NOW)).toBe("0:00");
    });
  });

  describe("scale_amount", () => {
    test("scales from the recipe's servings to the cook's, and says it as a cook would", async () => {
      expect(
        await run(scaleAmount, { amount: 0.75, unit: "cup", from_servings: 4, to_servings: 6 }),
      ).toEqual({ amount: 1.13, unit: "cup", say: "1 and a quarter cup" });
      expect(
        await run(scaleAmount, { amount: 300, unit: "g", from_servings: 4, to_servings: 6 }),
      ).toEqual({ amount: 450, unit: "g", say: "450 g" });
    });

    test("spokenAmount rounds to quarters", () => {
      expect(spokenAmount(0.1)).toBe("a pinch");
      expect(spokenAmount(0.5)).toBe("a half");
      expect(spokenAmount(1.5)).toBe("1 and a half");
      expect(spokenAmount(2.74)).toBe("2 and three quarters");
      expect(spokenAmount(3)).toBe("3");
    });
  });

  describe("GET /history", () => {
    const history = agentDef.routes?.["GET /history"] as RouteHandler;
    const request = (clientId?: string): RouteRequest => ({
      method: "GET",
      path: "/history",
      params: {},
      query: {},
      headers: {},
      body: undefined,
      ...omitUndefined({ clientId }),
    });
    const session = (sessionId: string, startedAt: number, said: string[]) => ({
      sessionId,
      startedAt,
      lastEventIndex: said.length,
      messages: said.map((text, i) => ({
        role: i % 2 === 0 ? "assistant" : "user",
        text,
        at: startedAt + i,
      })),
      tools: [],
    });

    test("lists this browser's conversations newest first, by what the cook said first", async () => {
      const asked: string[] = [];
      const ctx = createRouteContext({
        clientTranscript: async (clientId) => {
          asked.push(clientId);
          return {
            sessions: [
              session("s1", 100, ["Hi, what are we making?", "Risotto for four"]),
              // Greeted and left: nothing to recognize it by, so not listed.
              session("s2", 200, ["Hi, what are we making?"]),
              session("s3", 300, ["Hi", "Pancakes", "Sure", "Thanks"]),
            ],
          };
        },
      });
      expect(await history(request("browser-1"), ctx)).toEqual({
        conversations: [
          { sessionId: "s3", startedAt: 300, firstLine: "Pancakes", lines: 4 },
          { sessionId: "s1", startedAt: 100, firstLine: "Risotto for four", lines: 2 },
        ],
      });
      expect(asked).toEqual(["browser-1"]);
    });

    test("lists at most a few", async () => {
      const ctx = createRouteContext({
        clientTranscript: async () => ({
          sessions: Array.from({ length: MAX_LISTED + 3 }, (_, i) =>
            session(`s${i}`, i, ["Hi", "Soup"]),
          ),
        }),
      });
      const answer = (await history(request("b"), ctx)) as { conversations: unknown[] };
      expect(answer.conversations).toHaveLength(MAX_LISTED);
    });

    test("a request with no ?client= is refused, not answered with someone's history", async () => {
      expect(await history(request(), createRouteContext())).toMatchObject({ status: 400 });
    });
  });
});

/** A filled-in form, for the cases that vary one field. */
function form() {
  return { cook: "Sam", servings: "2", diet: "anything", pantry: "eggs" };
}
