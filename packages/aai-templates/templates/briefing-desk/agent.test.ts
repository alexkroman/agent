import {
  createToolContext,
  type StubDelegateCall,
  stubDelegate,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import authoredAgent from "./agent.ts";
import type { AngleWork, Finding } from "./shared.ts";
import {
  angleBrief,
  briefingSlot,
  countWork,
  factChecker,
  findByAngle,
  MAX_ANGLES,
  MAX_FINDINGS,
  MAX_RESEARCH_STEPS,
  recordFinding,
  researcher,
} from "./shared.ts";

/** A finding whose cost is irrelevant to the case at hand. */
const NO_WORK: AngleWork = { searches: 0, reads: 0 };

/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";

const run = toolRunner(agentDef);

/**
 * The desk's two subagents, faked.
 *
 * `stubDelegate` routes by SUBAGENT NAME, which is what tells a research run
 * from a check — the two things this desk actually does. Nothing here runs a
 * model or touches the network: a subagent is a model loop, and a spec that
 * asserted on its steps would be asserting on a provider's choices. What is
 * worth asserting is what the desk ASKS for and what it does with what comes
 * back.
 */
function desk(
  options: {
    research?: (call: StubDelegateCall) => string | { text: string; searches?: number };
    check?: string;
  } = {},
) {
  const research = options.research ?? ((call) => `Findings for ${call.task}.`);
  return stubDelegate({
    researcher: (call) => {
      const reply = research(call);
      if (typeof reply === "string") return { text: reply };
      return {
        text: reply.text,
        toolCalls: Array.from({ length: reply.searches ?? 0 }, (_unused, index) => ({
          name: "web_search",
          input: { query: `q${index}` },
        })),
      };
    },
    "fact-checker": options.check ?? "Confirmed: two sources say so.",
  });
}

describe("the desk itself", () => {
  test("has no web tools of its own — everything goes through a subagent", () => {
    // Stated as the claim the test's name makes, rather than as "no builtins at
    // all": giving the desk `run_code` is a reasonable edit, and it does not
    // put the web in front of the desk.
    expect(authoredAgent.builtinTools ?? []).not.toContain("web_search");
    expect(authoredAgent.builtinTools ?? []).not.toContain("visit_webpage");
    // And the subagents do, which is the split the template exists to show.
    expect(researcher.builtinTools).toContain("web_search");
    expect(factChecker.builtinTools).toContain("web_search");
  });

  test("gives the checker a tighter budget than the researcher", () => {
    expect(factChecker.maxSteps).toBeLessThan(MAX_RESEARCH_STEPS);
  });

  test("tells each subagent that its final message is all the desk sees", () => {
    expect(researcher.systemPrompt).toMatch(/FINAL message/);
  });
});

describe("research_topic", () => {
  test("fans every angle out as its own run, each with a self-contained task", async () => {
    const model = desk();
    const ctx = createToolContext({ delegate: model.delegate });

    await run(
      "research_topic",
      { topic: "home batteries", angles: ["price trend", "install lead times"] },
      ctx,
    );

    expect(model.calls).toHaveLength(2);
    expect(model.calls.map((call) => call.subagent.name)).toEqual(["researcher", "researcher"]);
    expect(model.calls.map((call) => call.task)).toEqual(["price trend", "install lead times"]);
    // The subagent has not heard the call, so the topic rides in `context`.
    expect(model.calls[0]?.options.context).toContain("home batteries");
  });

  test("starts the runs concurrently rather than one after another", async () => {
    let inFlight = 0;
    let peak = 0;
    const model = stubDelegate({
      researcher: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return "found";
      },
    });
    // The fake answers synchronously, so `inFlight` is only ever 1 unless the
    // tool really did start every run before awaiting any — which is the claim.
    const delegate = ((sub, options) =>
      model.delegate(sub, options).finally(() => {
        inFlight -= 1;
      })) as typeof model.delegate;

    await run(
      "research_topic",
      { topic: "t", angles: ["a", "b", "c"] },
      createToolContext({ delegate }),
    );

    expect(peak).toBe(3);
  });

  test("records what each angle concluded, and only that", async () => {
    const model = desk({
      research: (call) => ({ text: `Answer to ${call.task}.`, searches: 3 }),
    });
    const ctx = createToolContext({ delegate: model.delegate });

    const result = (await run("research_topic", { topic: "t", angles: ["a"] }, ctx)) as {
      findings: Finding[];
    };

    expect(result.findings).toEqual([
      { angle: "a", summary: "Answer to a.", work: { searches: 3, reads: 0 } },
    ]);
    const board = briefingSlot.get(ctx);
    expect(board.topic).toBe("t");
    expect(board.findings).toEqual(result.findings);
  });

  test("one failed angle does not sink the briefing", async () => {
    const model = stubDelegate({
      researcher: (call) => {
        if (call.task === "b") throw new Error("provider is having a day");
        return `Answer to ${call.task}.`;
      },
    });
    const ctx = createToolContext({ delegate: model.delegate });

    const result = (await run("research_topic", { topic: "t", angles: ["a", "b", "c"] }, ctx)) as {
      findings: { angle: string }[];
      failed: { angle: string; error: string }[];
      message: string;
    };

    expect(result.findings.map((one) => one.angle)).toEqual(["a", "c"]);
    expect(result.failed).toEqual([{ angle: "b", error: "provider is having a day" }]);
    // And the desk is told to say so rather than quietly reporting two angles.
    expect(result.message).toMatch(/could not get to/);
    expect(briefingSlot.get(ctx).findings).toHaveLength(2);
  });

  test("fails as a tool when every angle fails, quoting the first reason", async () => {
    const model = stubDelegate({
      researcher: () => {
        throw new Error("gateway said no");
      },
    });

    const result = await run(
      "research_topic",
      { topic: "t", angles: ["a", "b"] },
      createToolContext({ delegate: model.delegate }),
    );

    expect(result).toEqual({ error: expect.stringContaining("gateway said no") });
  });

  test("refuses a call whose angles are all blank, without spending a subagent", async () => {
    const model = desk();

    const result = await run(
      "research_topic",
      { topic: "t", angles: ["   "] },
      createToolContext({ delegate: model.delegate }),
    );

    expect(result).toEqual({ error: expect.stringContaining("No angles") });
    expect(model.calls).toEqual([]);
  });

  test("accepts at most MAX_ANGLES angles", () => {
    const schema = agentDef.tools.research_topic?.inputSchema;
    const tooMany = { topic: "t", angles: Array.from({ length: MAX_ANGLES + 1 }, () => "a") };
    expect(schema?.["~standard"].validate(tooMany)).toMatchObject({ issues: expect.anything() });
  });
});

describe("verify_claim", () => {
  test("asks the fact-checker, not the researcher", async () => {
    const model = desk({ check: "Contradicted: the figure is 12%." });
    const ctx = createToolContext({ delegate: model.delegate });

    const result = (await run("verify_claim", { claim: "The figure is 40%." }, ctx)) as {
      verdict: string;
      checkedAgainst: string | null;
    };

    expect(model.calls.map((call) => call.subagent.name)).toEqual(["fact-checker"]);
    expect(result.verdict).toBe("Contradicted: the figure is 12%.");
    expect(result.checkedAgainst).toBeNull();
  });

  test("quotes the finding a claim came from, so the checker can see the source", async () => {
    const model = desk();
    const ctx = createToolContext({ delegate: model.delegate });
    briefingSlot.update(ctx, (board) => {
      recordFinding(board, {
        angle: "install lead times",
        summary: "Installers quote eight weeks.",
        work: { searches: 2, reads: 1 },
      });
    });

    const result = (await run(
      "verify_claim",
      { claim: "Installs take eight weeks.", about: "lead times" },
      ctx,
    )) as { checkedAgainst: string | null };

    expect(model.calls[0]?.options.context).toContain("Installers quote eight weeks.");
    expect(result.checkedAgainst).toBe("install lead times");
  });

  test("reports a failed check as a tool failure the model can recover from", async () => {
    const model = stubDelegate({
      "fact-checker": () => {
        throw new Error("checker timed out");
      },
    });

    const result = await run(
      "verify_claim",
      { claim: "Something." },
      createToolContext({ delegate: model.delegate }),
    );

    expect(result).toEqual({ error: expect.stringContaining("checker timed out") });
  });

  test("refuses a blank claim without spending a subagent", async () => {
    const model = desk();
    const result = await run(
      "verify_claim",
      { claim: "  " },
      createToolContext({ delegate: model.delegate }),
    );
    expect(result).toEqual({ error: expect.stringContaining("Nothing to check") });
    expect(model.calls).toEqual([]);
  });
});

describe("briefing_so_far", () => {
  test("says so when there is nothing yet, and spends no subagent", async () => {
    const ctx = createToolContext();
    const result = (await run("briefing_so_far", {}, ctx)) as { findings: unknown[] };
    expect(result.findings).toEqual([]);
  });

  test("adds the lookups up across every angle", async () => {
    const ctx = createToolContext();
    briefingSlot.update(ctx, (board) => {
      board.topic = "t";
      recordFinding(board, { angle: "a", summary: "A.", work: { searches: 2, reads: 1 } });
      recordFinding(board, { angle: "b", summary: "B.", work: { searches: 3, reads: 0 } });
    });

    const result = (await run("briefing_so_far", {}, ctx)) as {
      totalSearches: number;
      totalReads: number;
    };
    expect(result.totalSearches).toBe(5);
    expect(result.totalReads).toBe(1);
  });
});

describe("the brief a subagent is sent", () => {
  test("carries the topic, because the subagent has not heard the call", () => {
    expect(angleBrief("home batteries", "price trend")).toEqual({
      task: "price trend",
      context: expect.stringContaining("home batteries"),
    });
  });
});

describe("countWork", () => {
  test("tells searches from page reads", () => {
    expect(
      countWork([
        { name: "web_search", input: {} },
        { name: "visit_webpage", input: {} },
        { name: "web_search", input: {} },
      ]),
    ).toEqual({ searches: 2, reads: 1 });
  });

  test("counts a tool it does not recognise as neither", () => {
    // A researcher that gains a third tool must not silently inflate "searches".
    expect(countWork([{ name: "think", input: {} }])).toEqual({ searches: 0, reads: 0 });
  });
});

describe("the board", () => {
  test("holds MAX_FINDINGS, dropping the oldest", () => {
    const ctx = createToolContext();
    briefingSlot.update(ctx, (board) => {
      for (let index = 0; index < MAX_FINDINGS + 3; index++) {
        recordFinding(board, { angle: `angle ${index}`, summary: "s", work: NO_WORK });
      }
    });
    const board = briefingSlot.get(ctx);
    expect(board.findings).toHaveLength(MAX_FINDINGS);
    expect(board.findings[0]?.angle).toBe("angle 3");
  });

  test("finds an angle from a loose mention, and nothing from a blank one", () => {
    const ctx = createToolContext();
    briefingSlot.update(ctx, (board) => {
      recordFinding(board, { angle: "install lead times", summary: "s", work: NO_WORK });
    });
    const board = briefingSlot.get(ctx);
    expect(findByAngle(board, "lead times")?.angle).toBe("install lead times");
    expect(findByAngle(board, "  ")).toBeUndefined();
    expect(findByAngle(board, "battery chemistry")).toBeUndefined();
  });
});
