/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type { InferToolInput, InferToolOutput } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDeployable,
  expectPromptBuiltinsDeclared,
  parseToolInput,
  toolInputIssues,
  toolRunner,
} from "@alexkroman1/aai/testing";
// The failure vocabulary from the subpath that DECLARES it — `/utils` is the
// zero-dependency half a tool body (and a page) reaches for, and `client.tsx`
// takes the same guard from the same place.
import { isToolFailure } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { CATEGORIES, MAX_RECS, MOODS, nightProjection, nightSlot } from "./shared.ts";
import type recommend from "./tools/recommend.ts";

/**
 * What `recommend` takes and answers, read off the tool itself.
 *
 * `InferToolInput`/`InferToolOutput` rather than the `{ category: string; mood:
 * string }` and `{ picks: string[] }` this spec used to hand-type: those are a
 * restatement of a schema declared two files away, they are WEAKER than it
 * (`string`, not the two enums), and nothing makes them fail when the schema
 * moves. Imported as a MODULE for it — `virtual:aai/agent` is the def a deploy
 * ships and is what every assertion below still drives, but a def erases which
 * tool has which shape.
 */
type RecommendInput = InferToolInput<typeof recommend>;
type RecommendResult = InferToolOutput<typeof recommend>;

/**
 * `runTool` takes the context in the ARGUMENTS' place when a tool needs none,
 * so `toolRunner`'s second parameter takes either — which is why it is one
 * signature rather than an overload pair. An omitted context is a fresh one,
 * i.e. a distinct session with an empty slot.
 */
const run = toolRunner(agentDef);

describe("night-owl template", () => {
  test("is deployable: validates, is nameable, and every stage its mode needs is filled", () => {
    // The same conversion `aai build`/`aai deploy` run. `expectDeployable`
    // rather than `expect(() => toAgentConfig(…)).not.toThrow()`: that spelling
    // fails as "expected function not to throw" and buries the sentence the
    // conversion wrote, and it checks neither the nameable nor the per-mode
    // stage cascade. `not.toThrow()` because the helper's throw IS the finding.
    expect(() => expectDeployable(agentDef)).not.toThrow();
  });

  test("declares run_code, which is the other half of the template", () => {
    // The sleep-time arithmetic is the builtin's job, not a tool's — that split
    // IS this template's subject, so a dropped builtin leaves the agent doing
    // mental arithmetic out loud. Asserted on the CONFIG, which is what a
    // deploy ships.
    expect(expectDeployable(agentDef).builtinTools).toContain("run_code");
  });

  test("every builtin the prompt tells Night Owl to use is one it declares", () => {
    // `system-prompt.md` heads its arithmetic rules with `run_code`, and
    // `agent.ts` is what makes that tool exist. The failure is silent in both
    // directions: a prompt commanding a builtin the agent never declared
    // produces a model apologising for a tool it cannot see. Which snake_case
    // tokens in the prose are tool NAMES is a question for the SDK's schema
    // rather than a list restated here — this prompt also names `wake_time`
    // and `cycles`, which any underscore-matching scan would redden on.
    expect(expectPromptBuiltinsDeclared(agentDef)).toContain("run_code");
  });

  test("recommend is discovered from tools/", () => {
    // `toContain` rather than an exact list: a file in `tools/` IS a tool, so
    // adding one is the edit this template most invites, and an exact list
    // would make that edit fail a test the author never wrote. What has to hold
    // is that discovery ran at all — a template whose `tools/` is never
    // resolved ships a model with no tools.
    expect(Object.keys(agentDef.tools ?? {})).toContain("recommend");
    // Its reading half, declared the same way and discovered the same way.
    expect(Object.keys(agentDef.tools ?? {})).toContain("revisit");
  });

  test("the projection an untouched session pushes is an empty log", () => {
    // What `useAgentState(nightProjection)` reads before the first tool call —
    // derived from the slot's own default rather than guessed at in the page.
    expect(nightProjection()).toEqual({ recs: [] });
  });
});

describe("recommend", () => {
  test("answers with picks for the category and mood asked for", async () => {
    const result = (await run("recommend", { category: "movie", mood: "cozy" })) as RecommendResult;
    expect(result).toMatchObject({ category: "movie", mood: "cozy" });
    expect(result.picks.length).toBeGreaterThan(0);
  });

  test("the picks land in the session's own log, newest first", async () => {
    // The log is STATE, not an event stream: `syncState` pushes this projection
    // after every tool call, so a page that reloads mid-session resumes with it
    // rather than starting empty.
    const ctx = createToolContext();
    const first = await run("recommend", { category: "book", mood: "spooky" }, ctx);
    const second = await run("recommend", { category: "music", mood: "chill" }, ctx);
    expect(nightProjection(nightSlot.get(ctx))).toEqual({ recs: [second, first] });
    // The two orders are DIFFERENT and both are deliberate: the slot keeps the
    // night in the order it happened, which is what a position word means and
    // which end `caps` trims; newest-first is the sidebar's, and the projection
    // is where that turn happens.
    expect(nightSlot.get(ctx).recs).toEqual([first, second]);
  });

  test("the log stops at the cap the slot declares, and it is the OLDEST that goes", async () => {
    // Declared on the slot rather than enforced by this tool, so the bound
    // holds whatever writes — the wrapper form only caps the paths that
    // remember to call it. The list rides every `syncState` frame, which is
    // what makes an unbounded one a real cost rather than a tidiness point.
    const ctx = createToolContext();
    const asked = Array.from({ length: MAX_RECS + 2 }, (_, i) => ({
      category: CATEGORIES[i % CATEGORIES.length]!,
      mood: MOODS[i % MOODS.length]!,
    }));
    for (const args of asked) await run("recommend", args, ctx);

    const key = (rec: { category: string; mood: string }) => `${rec.category}/${rec.mood}`;
    expect(nightSlot.get(ctx).recs.map(key)).toEqual(asked.slice(2).map(key));
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
        const result = (await run("recommend", { category, mood })) as RecommendResult;
        expect(result.picks, `${category}/${mood}`).not.toHaveLength(0);
      }
    }
  });

  test("the schema accepts a category/mood pair from the enums", async () => {
    const parsed = await parseToolInput<RecommendInput>(agentDef, "recommend", {
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

describe("revisit", () => {
  /** Three picks, in the order the night gave them. */
  const threePicks = async (ctx: ReturnType<typeof createToolContext>) => {
    await run("recommend", { category: "movie", mood: "cozy" }, ctx);
    await run("recommend", { category: "book", mood: "spooky" }, ctx);
    await run("recommend", { category: "music", mood: "chill" }, ctx);
  };

  test("a position counts the order the NIGHT went in, not the order the sidebar paints", async () => {
    const ctx = createToolContext();
    await threePicks(ctx);

    // The distinction is the whole reason the two orders are separate: the
    // sidebar's top card is the newest, and a listener saying "the last one you
    // gave me" means that same pick from the other end.
    expect(nightProjection(nightSlot.get(ctx)).recs[0]).toMatchObject({ category: "music" });
    expect(await run("revisit", { which: "the last one" }, ctx)).toMatchObject({
      category: "music",
      mood: "chill",
    });
    expect(await run("revisit", { which: "the second one" }, ctx)).toMatchObject({
      category: "book",
      mood: "spooky",
    });
  });

  test("the listener's own words pick one out when they name no position", async () => {
    const ctx = createToolContext();
    await threePicks(ctx);
    const found = (await run("revisit", { which: "those spooky books" }, ctx)) as RecommendResult;
    expect(found).toMatchObject({ category: "book", mood: "spooky" });
    // It answers with the shelf's own picks, which is what makes this a lookup
    // rather than the model recalling three titles from a trimmed transcript.
    expect(found.picks).toEqual(
      ((await run("recommend", { category: "book", mood: "spooky" })) as RecommendResult).picks,
    );
  });

  test("words that fit two entries equally refuse, listing them", async () => {
    // Never a guess: reading out the spooky book when they asked for the cozy
    // one is worse than asking which. The failure has to name the candidates,
    // because the companion reads it out as the question.
    const ctx = createToolContext();
    await run("recommend", { category: "movie", mood: "cozy" }, ctx);
    await run("recommend", { category: "book", mood: "cozy" }, ctx);

    const refused = await run("revisit", { which: "the cozy ones" }, ctx);
    expect(isToolFailure(refused)).toBe(true);
    expect(isToolFailure(refused) && refused.error).toMatch(/cozy movies/);
    expect(isToolFailure(refused) && refused.error).toMatch(/cozy books/);
  });

  test("an empty log refuses rather than answering", async () => {
    // The first thing `resolveOne` checks, and the one a hand-rolled lookup
    // reports as "nothing matched" — which sends the companion looking for a
    // pick it never gave.
    const refused = await run("revisit", { which: "the first one" });
    expect(isToolFailure(refused)).toBe(true);
    expect(isToolFailure(refused) && refused.error).toMatch(/recommendation/);
  });

  test("reading the log back writes nothing to it", async () => {
    // `slot.tool`, not `updateTool`: what a read is handed is frozen, so this
    // is a compile-time guarantee as much as a runtime one — the test is here
    // because the guarantee is the reason to declare a read tool as one.
    const ctx = createToolContext();
    await threePicks(ctx);
    const before = nightProjection(nightSlot.get(ctx));
    await run("revisit", { which: "the first one" }, ctx);
    await run("revisit", { which: "nothing like this" }, ctx);
    expect(nightProjection(nightSlot.get(ctx))).toEqual(before);
  });
});
