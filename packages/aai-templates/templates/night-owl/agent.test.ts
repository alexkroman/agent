/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import {
  createToolContext,
  parseToolInput,
  toolInputIssues,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { CATEGORIES, MOODS, nightProjection, nightSlot } from "./shared.ts";

/**
 * `runTool` takes the context in the ARGUMENTS' place when a tool needs none,
 * so `toolRunner`'s second parameter takes either — which is why it is one
 * signature rather than an overload pair. An omitted context is a fresh one,
 * i.e. a distinct session with an empty slot.
 */
const run = toolRunner(agentDef);

describe("night-owl template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("declares run_code, which is the other half of the template", () => {
    // The sleep-time arithmetic is the builtin's job, not a tool's — that split
    // IS this template's subject, so a dropped builtin leaves the agent doing
    // mental arithmetic out loud.
    expect(agentDef.builtinTools).toContain("run_code");
  });

  test("recommend is discovered from tools/", () => {
    // `toContain` rather than an exact list: a file in `tools/` IS a tool, so
    // adding one is the edit this template most invites, and an exact list
    // would make that edit fail a test the author never wrote. What has to hold
    // is that discovery ran at all — a template whose `tools/` is never
    // resolved ships a model with no tools.
    expect(Object.keys(agentDef.tools ?? {})).toContain("recommend");
  });

  test("the projection an untouched session pushes is an empty log", () => {
    // What `useAgentState(nightProjection)` reads before the first tool call —
    // derived from the slot's own default rather than guessed at in the page.
    expect(nightProjection()).toEqual({ recs: [] });
  });
});

describe("recommend", () => {
  test("answers with picks for the category and mood asked for", async () => {
    const result = await run("recommend", { category: "movie", mood: "cozy" });
    expect(result).toMatchObject({ category: "movie", mood: "cozy" });
    expect((result as { picks: string[] }).picks.length).toBeGreaterThan(0);
  });

  test("the picks land in the session's own log, newest first", async () => {
    // The log is STATE, not an event stream: `syncState` pushes this projection
    // after every tool call, so a page that reloads mid-session resumes with it
    // rather than starting empty.
    const ctx = createToolContext();
    const first = await run("recommend", { category: "book", mood: "spooky" }, ctx);
    const second = await run("recommend", { category: "music", mood: "chill" }, ctx);
    expect(nightProjection(nightSlot.get(ctx))).toEqual({ recs: [second, first] });
  });

  test("two calls with no shared context are two sessions", async () => {
    // The other half of the same rule, and the one that bites: an omitted
    // context is a FRESH session, so nothing accumulates across these calls.
    const ctx = createToolContext();
    await run("recommend", { category: "book", mood: "cozy" });
    expect(nightSlot.get(ctx).recs).toHaveLength(0);
  });

  test("the wind-down nudge is sent once, on the third pick", async () => {
    // A moment rather than state, which is why it is a `ctx.send` the page
    // consumes with `useEvent` and not a field on the projection: re-delivering
    // it on every reconnect would be nagging.
    const ctx = createToolContext();
    await run("recommend", { category: "movie", mood: "cozy" }, ctx);
    await run("recommend", { category: "music", mood: "cozy" }, ctx);
    expect(ctx.sent).toEqual([]);
    await run("recommend", { category: "book", mood: "cozy" }, ctx);
    expect(ctx.sent).toEqual([
      { event: "wind_down", data: "Three picks in. Want me to work out your bedtime?" },
    ]);
    await run("recommend", { category: "movie", mood: "chill" }, ctx);
    expect(ctx.sent).toHaveLength(1);
  });

  test("every category/mood pair the schema admits has picks behind it", async () => {
    // The table is hand-written and the schema is generated from the same two
    // const arrays, so a category added to `shared.ts` and forgotten in the
    // table is a `TypeError` on the first call — the exact failure this
    // package's guide records three shipped tools having.
    for (const category of CATEGORIES) {
      for (const mood of MOODS) {
        const result = await run("recommend", { category, mood });
        expect((result as { picks: string[] }).picks, `${category}/${mood}`).not.toHaveLength(0);
      }
    }
  });

  test("the schema accepts a category/mood pair from the enums", async () => {
    const parsed = await parseToolInput<{ category: string; mood: string }>(agentDef, "recommend", {
      category: "movie",
      mood: "cozy",
    });
    expect(parsed).toEqual({ category: "movie", mood: "cozy" });
  });

  test("a mood outside the enum is refused by the schema", async () => {
    // The wire boundary: an LLM tool call is untyped, so the schema is the only
    // thing between a hallucinated mood and an index into `undefined`.
    // `toolInputIssues` is the SDK's own ask — `~standard` is a vendor wire
    // contract, and the detail a hand-rolled version gets wrong first is that
    // `.validate` may be sync or async, so a missing `await` leaves `.issues`
    // undefined and the negative test passes for the wrong reason.
    expect(
      await toolInputIssues(agentDef, "recommend", { category: "movie", mood: "melancholy" }),
    ).toBeDefined();
  });
});
