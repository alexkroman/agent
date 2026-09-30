// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the deep-research STEPS, each driven directly against the stub
 * gateway and the stub delegate — no engine, no `ctx`. The body that composes
 * them is `deep-research.test.ts`.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_DEEP_RESEARCH_BUDGET, resolveSettings } from "./deep-research.ts";
import { DEFAULT_DEEP_RESEARCH_PROMPTS } from "./deep-research-prompts.ts";
import {
  citedSources,
  findGaps,
  findingsText,
  investigate,
  planAngles,
  writeBrief,
  writeReport,
} from "./deep-research-stages.ts";
import type { DeepResearchNote } from "./deep-research-types.ts";
import { FatalError } from "./step-error-classes.ts";
import { createToolContext } from "./testing.ts";
import type { StubDelegateCall } from "./testing-delegate.ts";
import {
  installStubGateway,
  installStubReporter,
  installStubStepDelegate,
} from "./testing-vitest.ts";

const defaults = resolveSettings({});
const brief = { brief: "How otters use tools", criteria: ["Which species", "How it is learned"] };
const a = { title: "A", url: "https://a.example" };
const b = { title: "B", url: "https://b.example" };
const c = { title: "C", url: "https://c.example" };

beforeEach(() => {
  vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
});

describe("the stages", () => {
  test("writeBrief turns a request into a brief, falling back to the topic", async () => {
    const calls = installStubGateway([
      JSON.stringify({ brief: "How otters use tools", criteria: ["Which species"] }),
    ]);
    expect(await writeBrief("otters", defaults)).toEqual({
      brief: "How otters use tools",
      criteria: ["Which species"],
    });
    expect(calls[0]?.prompt).toContain("otters");

    installStubGateway([JSON.stringify({ criteria: [] })]);
    expect(await writeBrief("otters", defaults)).toEqual({ brief: "otters", criteria: [] });
  });

  test("a prompt override reaches the model as the system prompt", async () => {
    const calls = installStubGateway([JSON.stringify({ brief: "x", criteria: [] })]);
    await writeBrief("otters", resolveSettings({ prompts: { brief: "PHONE BRIEF" } }));
    expect(calls[0]?.system).toContain("PHONE BRIEF");
  });

  test("a rejected request is FATAL, the step-errors classification", async () => {
    installStubGateway([""], { status: 401 });
    const err = await writeBrief("otters", defaults).catch((thrown: unknown) => thrown);
    expect(FatalError.is(err)).toBe(true);
  });

  test("planAngles caps the width at maxAngles, and researches the brief when none come back", async () => {
    installStubGateway([JSON.stringify({ angles: ["one", "two", "three"] })]);
    expect(await planAngles(brief, resolveSettings({ budget: { maxAngles: 2 } }))).toEqual([
      "one",
      "two",
    ]);
    installStubGateway([JSON.stringify({ angles: [] })]);
    expect(await planAngles(brief, defaults)).toEqual([brief.brief]);
  });

  test("investigate hands the angle to a researcher with the brief as context", async () => {
    const desk = installStubStepDelegate({ routes: { researcher: "Sea otters crack shellfish." } });
    const note = await investigate(brief, "Tool use", defaults);
    expect(note.findings).toBe("Sea otters crack shellfish.");
    expect(desk.calls[0]?.task).toBe("Tool use");
    expect(desk.calls[0]?.options.context).toContain("How otters use tools");
    const researcher = desk.calls[0]?.subagent;
    expect(researcher?.builtinTools).toEqual(["web_search", "visit_webpage"]);
    expect(researcher?.maxSteps).toBe(DEFAULT_DEEP_RESEARCH_BUDGET.researcherSteps);
    expect(researcher?.expectedOutput).toBe(DEFAULT_DEEP_RESEARCH_PROMPTS.researchOutput);
    expect(Object.keys(researcher?.tools ?? {})).toEqual(["cite"]);
  });

  test("the researcher option sets its builtins and adds tools, but cite stays the pass's", async () => {
    const desk = installStubStepDelegate({ routes: { researcher: "found" } });
    const extra = {
      cite: { description: "impostor", execute: () => "no" },
      notes: { description: "n", execute: () => "ok" },
    };
    await investigate(
      brief,
      "Tool use",
      resolveSettings({
        researcher: { builtinTools: ["brave_search", "visit_webpage"], tools: extra },
        budget: { researcherSteps: 3 },
      }),
    );
    const researcher = desk.calls[0]?.subagent;
    expect(researcher?.builtinTools).toEqual(["brave_search", "visit_webpage"]);
    expect(researcher?.maxSteps).toBe(3);
    expect(Object.keys(researcher?.tools ?? {}).sort()).toEqual(["cite", "notes"]);
    expect(researcher?.tools?.cite?.description).not.toBe("impostor");
  });

  test("sources are what it CITED, else what it OPENED, and the cost is narrated", async () => {
    installStubStepDelegate({
      routes: {
        researcher: (call: StubDelegateCall) => {
          void call.subagent.tools?.cite?.execute(
            { title: "Otters", url: "https://otters.example" },
            createToolContext(),
          );
          return "cited";
        },
      },
    });
    expect((await investigate(brief, "x", defaults)).sources).toEqual([
      { title: "Otters", url: "https://otters.example" },
    ]);

    const reported = installStubReporter();
    installStubStepDelegate({
      routes: {
        researcher: {
          text: "found",
          toolCalls: [
            { name: "brave_search", input: { query: "a" } },
            { name: "web_search", input: { query: "b" } },
            { name: "visit_webpage", input: { url: "https://p.example" } },
            { name: "visit_webpage", input: "https://p.example" },
          ],
        },
      },
    });
    const note = await investigate(brief, "Tool use", defaults);
    expect(note.sources).toEqual([{ title: "https://p.example", url: "https://p.example" }]);
    expect(reported.lines.join("\n")).toContain("2 searches, 2 pages read");
  });

  test("findGaps asks nothing when the first wave found nothing, and caps at maxGapAngles", async () => {
    const calls = installStubGateway([JSON.stringify({ angles: ["g1", "g2", "g3", "g4"] })]);
    expect(await findGaps(brief, [], defaults)).toEqual([]);
    expect(calls).toHaveLength(0);
    const gaps = await findGaps(
      brief,
      [{ angle: "x", findings: "They use stones.", sources: [] }],
      resolveSettings({ budget: { maxGapAngles: 2 } }),
    );
    expect(gaps).toEqual(["g1", "g2"]);
    expect(calls[0]?.prompt).toContain("They use stones.");
  });

  test("writeReport numbers sources once across notes, and summarizes the REPORT", async () => {
    const calls = installStubGateway(["# Otters\n\nStones [2].", "Otters use stones."]);
    const notes: DeepResearchNote[] = [
      { angle: "how", findings: "Stones.", sources: [a, b] },
      { angle: "who", findings: "Sea otters.", sources: [b, c] },
    ];
    const written = await writeReport("otters", brief, notes, defaults);
    expect(written).toEqual({ report: "# Otters\n\nStones [2].", summary: "Otters use stones." });
    expect(calls[0]?.prompt).toContain("Sources used here: [2] [3]");
    expect(calls[0]?.prompt).toContain("[3] C (https://c.example)");
    expect(calls[1]?.prompt).toContain("# Otters");
  });
});

describe("the pure readers", () => {
  test("findingsText numbers every source once, first seen first", () => {
    const text = findingsText(
      [
        { angle: "one", findings: "f1", sources: [a, b] },
        { angle: "two", findings: "f2", sources: [] },
      ],
      [a, b],
    );
    expect(text).toContain("## one\nf1\nSources used here: [1] [2]");
    expect(text).toContain("## two\nf2\nSources used here: none");
  });

  test("citedSources maps a report's numbers back to OUR sources, dropping unknown ones", () => {
    expect(citedSources("Cheap [3], quiet [1][3], and [9].", [a, b, c])).toEqual([
      { ...a, number: 1 },
      { ...c, number: 3 },
    ]);
  });
});
