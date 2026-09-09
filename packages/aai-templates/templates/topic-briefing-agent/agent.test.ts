import type { DelegateOptions, SubagentDef } from "@alexkroman1/aai";
import { DELEGATE_TOOL_NAME, isToolFailure } from "@alexkroman1/aai";
import {
  createToolContext,
  type StubDelegateCall,
  scriptedToolContext,
  stubDelegate,
  toolOf,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { installStubStepFetch } from "@alexkroman1/aai/testing/vitest";
import { describe, expect, test } from "vitest";
import authoredAgent from "./agent.ts";
import type { AngleWork, Finding } from "./shared.ts";
import {
  angleBrief,
  briefingSlot,
  CHEAP_MODEL,
  counterpoint,
  countWork,
  explainer,
  factChecker,
  findByAngle,
  MAX_ANGLES,
  MAX_FINDINGS,
  MAX_RESEARCH_STEPS,
  researcher,
  VerdictSchema,
} from "./shared.ts";
import { briefingChannel, briefingMessage, DESTINATION_ENV } from "./slack.ts";

/** A finding whose cost is irrelevant to the case at hand. */
const NO_WORK: AngleWork = { searches: 0, reads: 0 };

/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";

const run = toolRunner(agentDef);
const deployed = agentDef;

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
function scriptedDesk(
  options: {
    research?: (call: StubDelegateCall) => string | { text: string; searches?: number };
    check?: string;
  } = {},
) {
  const research = options.research ?? ((call) => `Findings for ${call.task}.`);
  return scriptedToolContext({
    delegate: {
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
      "fact-checker": options.check ?? '{"verdict": "confirmed", "detail": "Two sources say so."}',
    },
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

  test("runs the three NARROW subagents somewhere cheaper, and the researcher on the default", () => {
    // The other half of the budget split, and the reason `CHEAP_MODEL` is one
    // constant: three subagents that were each meant to be cheap, one of
    // which quietly is not, is a bill nobody can read.
    for (const one of [factChecker, explainer, counterpoint]) {
      expect(one.llm, one.name).toMatchObject({ options: { model: CHEAP_MODEL } });
    }
    // The researcher reads whole pages and stays on the agent's own model.
    expect(researcher.llm).toBeUndefined();
  });

  test("declares what every subagent's final message has to be", () => {
    // The rule that decides whether delegation works at all, and it is a FIELD
    // rather than a paragraph somebody remembered to write: the desk reads the
    // final message and nothing else. A subagent added here without one is the
    // regression this catches.
    for (const one of [researcher, factChecker, explainer, counterpoint]) {
      expect(one.expectedOutput, one.name).toBeTruthy();
    }
    expect(researcher.expectedOutput).toMatch(/only this/);
  });

  test("puts on the roster exactly the subagents chosen by what the caller ASKED", () => {
    // The two tools name their own subagent, so those two must NOT be on the
    // roster: a subagent reachable both ways gives the model a second, worse
    // route to a tool that does real work around the delegation.
    expect(authoredAgent.subagents?.map((one) => one.name)).toEqual(["explainer", "counterpoint"]);
    for (const one of authoredAgent.subagents ?? []) {
      // The only thing the router reads. `agent()` refuses a roster without it;
      // asserted here too because the template is what an author copies.
      expect(one.description, one.name).toBeTruthy();
    }
  });

  test("publishes the roster as one delegate tool listing both subagents", () => {
    const delegate = deployed.tools[DELEGATE_TOOL_NAME];
    expect(delegate).toBeDefined();
    expect(delegate?.description).toContain("explainer:");
    expect(delegate?.description).toContain("counterpoint:");
  });
});

describe("the fact-checker's schema", () => {
  test("admits exactly the three verdicts the desk can act on", () => {
    for (const verdict of ["confirmed", "contradicted", "unclear"]) {
      expect(VerdictSchema.safeParse({ verdict, detail: "why" }).success).toBe(true);
    }
    // The failure this exists for: a hedge the desk cannot tell from a
    // confirmation, which `tools/verify_claim.ts` would then read out as one.
    // It is not a judgement call any more — it does not parse.
    expect(VerdictSchema.safeParse({ verdict: "probably", detail: "why" }).success).toBe(false);
    expect(VerdictSchema.safeParse({ verdict: "confirmed" }).success).toBe(false);
  });

  test("the checker declares it, so the runtime is what enforces it", () => {
    expect(factChecker.schema).toBe(VerdictSchema);
    // And the guardrail it replaced is gone: a guardrail is for the judgement a
    // shape cannot express, and a three-word enum was never that.
    expect(factChecker.guardrail).toBeUndefined();
  });
});

describe("research_topic", () => {
  test("fans every angle out as its own run, each with a self-contained task", async () => {
    const { ctx, desk: subagents } = scriptedDesk();

    await run(
      "research_topic",
      { topic: "home batteries", angles: ["price trend", "install lead times"] },
      ctx,
    );

    expect(subagents.calls).toHaveLength(2);
    expect(subagents.calls.map((call) => call.subagent.name)).toEqual(["researcher", "researcher"]);
    expect(subagents.calls.map((call) => call.task)).toEqual(["price trend", "install lead times"]);
    // The subagent has not heard the call, so the topic rides in `context`.
    expect(subagents.calls[0]?.options.context).toContain("home batteries");
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
    // Parameters ANNOTATED rather than inferred: `DelegateFn` is overloaded
    // (a subagent with a `schema` answers with a parsed `object`), and a bare
    // arrow has no single signature to contextually type itself against.
    const delegate = ((sub: SubagentDef, options: DelegateOptions) =>
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
    const { ctx } = scriptedDesk({
      research: (call) => ({ text: `Answer to ${call.task}.`, searches: 3 }),
    });

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
    const { ctx, desk: subagents } = scriptedDesk();

    const result = await run("research_topic", { topic: "t", angles: ["   "] }, ctx);

    expect(result).toEqual({ error: expect.stringContaining("No angles") });
    expect(subagents.calls).toEqual([]);
  });

  test("accepts at most MAX_ANGLES angles", () => {
    const schema = agentDef.tools.research_topic?.inputSchema;
    const tooMany = { topic: "t", angles: Array.from({ length: MAX_ANGLES + 1 }, () => "a") };
    expect(schema?.["~standard"].validate(tooMany)).toMatchObject({ issues: expect.anything() });
  });
});

describe("verify_claim", () => {
  test("asks the fact-checker, not the researcher", async () => {
    const { ctx, desk: subagents } = scriptedDesk({
      check: '{"verdict": "contradicted", "detail": "The figure is 12%."}',
    });

    const result = (await run("verify_claim", { claim: "The figure is 40%." }, ctx)) as {
      verdict: string | null;
      detail: string;
      checkedAgainst: string | null;
    };

    expect(subagents.calls.map((call) => call.subagent.name)).toEqual(["fact-checker"]);
    // The WORD the desk branches on, parsed — not a sentence it must read one out of.
    expect(result.verdict).toBe("contradicted");
    expect(result.detail).toBe("The figure is 12%.");
    expect(result.checkedAgainst).toBeNull();
  });

  test("quotes the finding a claim came from, so the checker can see the source", async () => {
    const { ctx, desk: subagents } = scriptedDesk();
    briefingSlot.update(ctx, (board) => {
      board.findings.push({
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

    expect(subagents.calls[0]?.options.context).toContain("Installers quote eight weeks.");
    expect(result.checkedAgainst).toBe("install lead times");
  });

  test("tells the desk not to act on a verdict the schema never accepted", async () => {
    // A run the runtime could not parse after its retries: `accepted` is false
    // and the complaint says why. The scripted text is well-formed here because
    // `stubDelegate` parses it — what makes this the UNACCEPTED case is the
    // staged `complaint`.
    const model = stubDelegate({
      "fact-checker": {
        text: '{"verdict": "unclear", "detail": "Nothing conclusive."}',
        complaint: "no verdict word",
      },
    });

    const result = (await run(
      "verify_claim",
      { claim: "Prices fell." },
      createToolContext({ delegate: model.delegate }),
    )) as { verdict: string | null; detail: string; unusable?: string; message: string };

    // Not a tool failure: there IS an answer, and the desk is on a live call.
    // What changes is the instruction — the desk must not round a hedge up to a
    // confirmation, which is exactly what it would have done before. `verdict`
    // is null rather than a word, so there is nothing to round.
    expect(result.verdict).toBeNull();
    expect(result.unusable).toBe("no verdict word");
    expect(result.message).toContain("unresolved");
  });

  test("carries no `unusable` when the verdict was accepted", async () => {
    const { ctx } = scriptedDesk({
      check: '{"verdict": "confirmed", "detail": "Two sources say so."}',
    });

    const result = (await run("verify_claim", { claim: "Prices fell." }, ctx)) as {
      unusable?: string;
      message: string;
    };

    expect(result.unusable).toBeUndefined();
    expect(result.message).toContain("correct what you told them earlier");
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
    const { ctx, desk: subagents } = scriptedDesk();
    const result = await run("verify_claim", { claim: "  " }, ctx);
    expect(result).toEqual({ error: expect.stringContaining("Nothing to check") });
    expect(subagents.calls).toEqual([]);
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
      board.findings.push({ angle: "a", summary: "A.", work: { searches: 2, reads: 1 } });
      board.findings.push({ angle: "b", summary: "B.", work: { searches: 3, reads: 0 } });
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
        board.findings.push({ angle: `angle ${index}`, summary: "s", work: NO_WORK });
      }
    });
    const board = briefingSlot.get(ctx);
    expect(board.findings).toHaveLength(MAX_FINDINGS);
    expect(board.findings[0]?.angle).toBe("angle 3");
  });

  test("finds an angle from a loose mention, and nothing from a blank one", () => {
    const ctx = createToolContext();
    briefingSlot.update(ctx, (board) => {
      board.findings.push({ angle: "install lead times", summary: "s", work: NO_WORK });
    });
    const board = briefingSlot.get(ctx);
    const found = findByAngle(board, "lead times");
    expect(isToolFailure(found) ? found : found.angle).toBe("install lead times");
  });

  test("an angle the caller could mean two ways is ASKED about, not guessed", () => {
    // What the `.find()` this replaced did: it took the first angle whose text
    // overlapped in either direction, so board order decided which of these the
    // claim got checked against — and it answered `undefined` for "nothing
    // matches" and "several do" alike.
    const ctx = createToolContext();
    briefingSlot.update(ctx, (board) => {
      board.findings.push({ angle: "install lead times", summary: "s", work: NO_WORK });
      board.findings.push({ angle: "battery lead times", summary: "s", work: NO_WORK });
    });
    const found = findByAngle(briefingSlot.get(ctx), "lead times");
    expect(isToolFailure(found)).toBe(true);
    expect(isToolFailure(found) && found.error).toContain("install lead times");
    expect(isToolFailure(found) && found.error).toContain("battery lead times");
  });

  test("an angle on nothing, and a blank one, each say so", () => {
    const ctx = createToolContext();
    briefingSlot.update(ctx, (board) => {
      board.findings.push({ angle: "install lead times", summary: "s", work: NO_WORK });
    });
    const board = briefingSlot.get(ctx);
    const missing = findByAngle(board, "battery chemistry");
    expect(isToolFailure(missing) && missing.error).toContain("install lead times");
    const blank = findByAngle(board, "  ");
    expect(isToolFailure(blank) && blank.error).toContain("which angle");
  });
});

// ---- Sending it on ----------------------------------------------------------

/** A destination that really is Slack's, which is what the guard checks. */
const WEBHOOK = "https://hooks.slack.com/services/T00/B00/xxxxxxxx";

/** A context with a board on it and a channel configured. */
function deskWithBoard(env: Record<string, string> = { [DESTINATION_ENV]: WEBHOOK }) {
  const ctx = createToolContext({ env });
  briefingSlot.update(ctx, (board) => {
    board.topic = "home batteries";
    board.findings.push({
      angle: "price trend",
      summary: "Pack prices fell 14% year on year.",
      work: { searches: 2, reads: 1 },
    });
    board.findings.push({
      angle: "install lead times",
      summary: "Installers quote eight weeks.",
      work: { searches: 3, reads: 0 },
    });
  });
  return ctx;
}

describe("the briefing as a channel message", () => {
  /**
   * What is left to assert here once the channel owns the wire: the MESSAGE,
   * not the payload. Slack's two webhook shapes, the Block Kit assembly and the
   * mrkdwn escaping are `@alexkroman1/aai/channels`' and are covered by its own
   * specs — a template asserting them again would pin the SDK's rendering from
   * the outside.
   */
  test("carries every angle as its own section, in the order they were researched", () => {
    const message = briefingMessage(briefingSlot.get(deskWithBoard()));

    expect(message.heading).toBe("Briefing: home batteries");
    expect(message.sections).toEqual([
      { title: "price trend", body: "Pack prices fell 14% year on year." },
      { title: "install lead times", body: "Installers quote eight weeks." },
    ]);
  });

  test("says how many angles in the notification line and what they cost in the subtitle", () => {
    const message = briefingMessage(briefingSlot.get(deskWithBoard()));

    // The notification line is the WHOLE message on a Slack workflow trigger,
    // so it has to stand on its own.
    expect(message.text).toBe("Briefing on home batteries: 2 angles");
    // The same two numbers `briefing_so_far` reads back, from the same helper.
    expect(message.subtitle).toBe("5 searches, 1 page read");
  });

  test("still names something when the board carries findings and no topic", () => {
    // Reachable: a tool can push to the board without setting `topic`, and a
    // heading reading "Briefing: null" is the kind of thing a channel keeps
    // forever.
    const ctx = createToolContext();
    briefingSlot.update(ctx, (board) => {
      board.findings.push({ angle: "a", summary: "A.", work: NO_WORK });
    });

    const message = briefingMessage(briefingSlot.get(ctx));

    expect(message.heading).toBe("Briefing: an unnamed subject");
    expect(message.text).toBe("Briefing on an unnamed subject: 1 angle");
    expect(message.subtitle).toBe("0 searches, 0 pages read");
  });

  test("refuses a destination that is not Slack, before anything is posted", () => {
    // A security boundary rather than a typo check: the value is the target of
    // a POST carrying everything the desk was told.
    const refused = briefingChannel("https://example.test/collect");
    expect(isToolFailure(refused) && refused.error).toContain(DESTINATION_ENV);
    expect(briefingChannel(WEBHOOK)).toMatchObject({ kind: "slack" });
  });
});

describe("send_briefing", () => {
  test("posts the board to the configured channel and reports what went", async () => {
    // `installStubStepFetch`, not a stubbed global: a channel posts through the
    // SDK's own `stepFetch` slot, and stubbing the global would test a path
    // production does not take.
    const posted = installStubStepFetch(() => ({ body: "ok" }));

    const result = (await run("send_briefing", {}, deskWithBoard())) as {
      sent: number;
      topic: string | null;
      message: string;
    };

    expect(posted.calls).toHaveLength(1);
    expect(posted.calls[0]?.url).toBe(WEBHOOK);
    expect(posted.calls[0]?.method).toBe("POST");
    expect(result).toMatchObject({ sent: 2, topic: "home batteries" });
    expect(result.message).toMatch(/in writing/);
  });

  test("spends no request on an empty board", async () => {
    const posted = installStubStepFetch(() => ({ body: "ok" }));
    const ctx = createToolContext({ env: { [DESTINATION_ENV]: WEBHOOK } });

    const result = await run("send_briefing", {}, ctx);

    expect(result).toEqual({ error: expect.stringContaining("nothing to send") });
    expect(posted.calls).toEqual([]);
  });

  test("offers to try again when Slack is having a bad minute", async () => {
    installStubStepFetch(() => ({ status: 503, body: { error: "server_error" } }));

    const result = await run("send_briefing", {}, deskWithBoard());

    expect(isToolFailure(result) && result.error).toMatch(/try again/);
  });

  test("does NOT offer a retry for a refusal that will answer the same way forever", async () => {
    // The 4xx/5xx split is the whole reason this goes through a channel: a
    // revoked webhook answers identically on every attempt, and promising the
    // caller another go is a promise the desk cannot keep.
    installStubStepFetch(() => ({ status: 403, body: { error: "invalid_token" } }));

    const result = await run("send_briefing", {}, deskWithBoard());

    expect(isToolFailure(result) && result.error).toMatch(/will not help/);
    expect(isToolFailure(result) && result.error).not.toMatch(/try again/);
  });

  test("reports a connection that never got there as itself", async () => {
    // Not a `ChannelDeliveryError`: there was no response to classify. The
    // channel cannot say whether a retry would help, so neither does the desk.
    installStubStepFetch(() => {
      throw new Error("connection reset");
    });

    const result = await run("send_briefing", {}, deskWithBoard());

    expect(isToolFailure(result) && result.error).toMatch(/did not send/);
    expect(isToolFailure(result) && result.error).toContain("connection reset");
  });

  test("names the missing variable when no channel is configured", async () => {
    // The one deliberate throw in this template: a missing credential is not
    // something the call can recover from, and the message is the fix.
    const posted = installStubStepFetch(() => ({ body: "ok" }));

    await expect(run("send_briefing", {}, deskWithBoard({}))).rejects.toThrow(DESTINATION_ENV);
    expect(posted.calls).toEqual([]);
  });

  test("declares onError, so a missing webhook is FATAL rather than something to retry", () => {
    // Without it the runtime hands every throw to the model as this call's
    // result, and the desk re-calls `send_briefing` against a variable that is
    // still unset — burning the reply's step budget on a deploy fault. The
    // handler re-throws, which is how a tool says "stop, this cannot work".
    const sender = toolOf(deployed, "send_briefing");
    expect(sender.onError).toBeDefined();
    const cause = new Error(`Missing required environment variable: ${DESTINATION_ENV}`);
    expect(() => sender.onError?.(cause, createToolContext())).toThrow(cause);
  });

  test("refuses a configured destination that is not Slack, without posting", async () => {
    const posted = installStubStepFetch(() => ({ body: "ok" }));
    const ctx = deskWithBoard({ [DESTINATION_ENV]: "https://example.test/collect" });

    const result = await run("send_briefing", {}, ctx);

    expect(isToolFailure(result) && result.error).toContain(DESTINATION_ENV);
    expect(posted.calls).toEqual([]);
  });
});
