/**
 * Specs for the redline desk — the reflection port, as a workflow app.
 *
 * The declaration is testable (the input schema, which is both the call-site
 * validation and the form the page renders) and so are the STEPS, which
 * imported with no bundler in the path are ordinary async functions: their JSON
 * contract with the model, their `FatalError` guards, and the pure helpers
 * underneath them.
 *
 * **And so is the loop's EXIT**: `runWorkflow`
 * (`@alexkroman1/aai-runtime/testing`) runs this body on the real replay engine
 * over an in-memory journal. The last block below is that claim, asserted the
 * only way it can be: crash the desk mid-round, hand the journal to a fresh
 * engine, and count the model calls the resume did NOT make.
 */

import { FatalError } from "@alexkroman1/aai/step-errors";
import type { WorkflowTestStep } from "@alexkroman1/aai-runtime/testing";
import { parseSchemaInput, runWorkflow, schemaInputIssues } from "@alexkroman1/aai-runtime/testing";
import { installStubWorld } from "@alexkroman1/aai-runtime/testing/vitest";
import { describe, expect, test } from "vitest";
import agentDef, { MAX_ROUNDS, redline } from "./agent.ts";
import {
  acceptDraft,
  briefBlock,
  clampScore,
  critiqueDraft,
  MAX_NOTES,
  MIN_DRAFT_CHARS,
  type RedlineInput,
  reviseDraft,
  writeDraft,
} from "./workflows/redline.ts";

const INPUT: RedlineInput = {
  brief: "Explain why our API returns 402 when a workspace is over budget.",
  audience: "customers",
  rounds: 2,
  mustCover: ["what to do about it", "how to raise the cap"],
};

/** A draft long enough for the desk to take, as a file the page would have read. */
const ATTACHED = {
  name: "over-budget.md",
  text: `A 402 means the workspace is over its budget. ${"Every call is refused until the cap is raised. ".repeat(4)}`,
};

/** The journal's own record of which call sites a walk reached, in its order. */
const stepKeys = (steps: readonly WorkflowTestStep[]): string[] => steps.map((step) => step.key);

/** The model is the whole world here: every step is an `orFail(stepGenerate*)`. */
const model = (replies: string | readonly string[]) => installStubWorld({ model: replies }).model;

// ─── 1. The declaration ──────────────────────────────────────────────────────

describe("the input schema", () => {
  // `schemaInputIssues` / `parseSchemaInput` rather than a local reach through
  // `["~standard"].validate`: that is the vendor WIRE contract, and whether it
  // answers synchronously or with a promise is the vendor's business.
  const issues = (value: unknown) => schemaInputIssues(redline.input, value, "redline");

  test("caps the rounds at the CALL SITE rather than on the bill", async () => {
    expect(await issues({ ...INPUT, rounds: MAX_ROUNDS + 1 })).toBeDefined();
  });

  test("defaults the rounds and the required points, so the form need not", async () => {
    const parsed = await parseSchemaInput(
      redline.input,
      { brief: INPUT.brief, audience: "engineers" },
      "redline",
    );
    expect(parsed).toMatchObject({ rounds: 2, mustCover: [] });
  });

  test("rejects an audience outside the enum — which is also what makes it a select", async () => {
    // `<WorkflowFields>` renders a `z.enum` as a `<SelectField>`; the same
    // declaration is what stops an API caller inventing a fifth audience.
    expect(await issues({ ...INPUT, audience: "cats" })).toBeDefined();
  });

  test("declares mustCover as an array, which the form takes one line at a time", async () => {
    // An array of strings is the shape `<WorkflowFields>` renders as a
    // `split="lines"` textarea, contributing a `string[]`.
    expect(await issues({ ...INPUT, mustCover: "one point" })).toBeDefined();
    expect(await issues({ ...INPUT, mustCover: ["one point"] })).toBeUndefined();
  });

  test("takes an attached draft as an OBJECT, and refuses one too short to grade", async () => {
    expect(await issues({ ...INPUT, source: ATTACHED })).toBeUndefined();
    // `{ name, text }` is the shape `<WorkflowFields>` renders as a file picker
    // that reads the file in the browser: the name is what the run narrates
    // and the output carries back.
    expect(await issues({ ...INPUT, source: { text: ATTACHED.text } })).toBeDefined();
    expect(await issues({ ...INPUT, source: ATTACHED.text })).toBeDefined();
    expect(
      await issues({ ...INPUT, source: { name: "stub.md", text: "Too short." } }),
    ).toBeDefined();
  });

  test("and omitting it is the ordinary run rather than a validation error", async () => {
    // Nothing chosen contributes no key at all, so absence has to be the
    // default, not a special case.
    expect(await issues(INPUT)).toBeUndefined();
  });
});

// ─── 2. Pure helpers ─────────────────────────────────────────────────────────

describe("pure helpers", () => {
  test("briefBlock restates the brief the same way for all three stages", () => {
    const block = briefBlock(INPUT);
    expect(block).toContain(INPUT.brief);
    expect(block).toContain("customers");
    expect(block).toContain("- how to raise the cap");
  });

  test("briefBlock says so when nothing was required, rather than showing an empty list", () => {
    expect(briefBlock({ ...INPUT, mustCover: [] })).toContain("nothing specific");
  });

  test("clampScore holds a model's number inside the range it was given", () => {
    expect(clampScore(12)).toBe(10);
    expect(clampScore(0)).toBe(1);
    expect(clampScore(7.4)).toBe(7);
    expect(clampScore(Number.NaN)).toBe(0);
  });
});

// ─── 3. The steps ────────────────────────────────────────────────────────────

describe("the steps", () => {
  describe("writeDraft", () => {
    test("returns the piece the model wrote, trimmed", async () => {
      const calls = model("\n  A draft about 402s.  \n");
      expect(await writeDraft(INPUT)).toBe("A draft about 402s.");
      // The brief reaches the writer — otherwise it writes something else well.
      expect(calls[0]?.prompt).toContain("how to raise the cap");
    });

    test("fails FATALLY on a brief that is only whitespace", async () => {
      // The schema's `.min(20)` counts CHARACTERS, so twenty spaces validate at
      // `start()` and arrive here as nothing to write from. No number of
      // attempts makes a brief longer, so it is fatal rather than retryable.
      model("unused");
      await expect(writeDraft({ ...INPUT, brief: " ".repeat(25) })).rejects.toThrow(/too short/);
    });

    test("lets the SDK refuse an empty completion, RETRYABLY", async () => {
      // Neither writer step carries an empty-reply guard, because `stepGenerate`
      // already has one — and its verdict is the one that matters: retryable, so
      // a blank answer costs an attempt rather than the run.
      model("   ");
      const failure = await writeDraft(INPUT).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(FatalError);
      expect(String(failure)).toMatch(/empty completion/);
    });
  });

  describe("acceptDraft", () => {
    test("hands the attached file's text to the loop, trimmed, and calls no model", async () => {
      const calls = model("nothing should ask for this");
      expect(await acceptDraft({ ...ATTACHED, text: `\n  ${ATTACHED.text}  \n` })).toBe(
        ATTACHED.text.trim(),
      );
      // The whole point of the other way in: the writer never runs, so the
      // desk's first model call is the critique.
      expect(calls).toHaveLength(0);
    });

    test("fails FATALLY on a file with nothing in it to grade", async () => {
      // The same layering as `writeDraft`: the schema's `.min()` counts
      // CHARACTERS, so a file of nothing but whitespace validates at `start()`
      // and arrives here as nothing to critique. The message names the file,
      // since a desk that took three attachments cannot say which.
      const failure = await acceptDraft({
        name: "empty.md",
        text: " ".repeat(MIN_DRAFT_CHARS + 5),
      }).catch((err: unknown) => err);

      expect(FatalError.is(failure)).toBe(true);
      expect((failure as Error).message).toContain("empty.md");
    });
  });

  describe("critiqueDraft", () => {
    test("returns the verdict the body branches on, with the score clamped", async () => {
      model('{"verdict":"ship","score":42,"notes":["nothing major"]}');
      const critique = await critiqueDraft("A draft.", INPUT, 1);
      expect(critique.verdict).toBe("ship");
      expect(critique.score).toBe(10);
    });

    test("keeps at most the notes the schema asked for", async () => {
      const notes = JSON.stringify(["a", "b", "c", "d", "e"]);
      model(`{"verdict":"revise","score":6,"notes":${notes}}`);
      const critique = await critiqueDraft("A draft.", INPUT, 1);
      expect(critique.notes).toHaveLength(MAX_NOTES);
    });

    test("unwraps a fenced reply rather than failing on it", async () => {
      model('```json\n{"verdict":"revise","score":5,"notes":["thin"]}\n```');
      expect((await critiqueDraft("A draft.", INPUT, 1)).notes).toEqual(["thin"]);
    });

    test("throws PLAINLY when the critic answered with prose, so the step retries", async () => {
      // The distinction that is the whole retry policy: a model that ignored the
      // format may well obey on the next attempt, where a 401 will not.
      model("I think the draft is pretty good, honestly.");
      const err = await critiqueDraft("A draft.", INPUT, 1).catch((thrown: unknown) => thrown);

      expect(FatalError.is(err)).toBe(false);
      expect((err as Error).message).toMatch(/Expected JSON from the model/);
    });

    test("rejects a verdict outside the two the loop understands", async () => {
      // Anything else would be read as "not ship" and quietly cost a round. The
      // schema NAMES the field.
      model('{"verdict":"looks fine","score":8,"notes":[]}');
      await expect(critiqueDraft("A draft.", INPUT, 1)).rejects.toThrow(
        /did not match the shape: verdict/,
      );
    });
  });

  describe("reviseDraft", () => {
    const CRITIQUE = { verdict: "revise" as const, score: 5, notes: ["Say what to do about it."] };

    test("sends the notes to the reviser and returns the revision", async () => {
      const calls = model("A better draft about 402s.");
      const revised = await reviseDraft("A draft.", CRITIQUE, INPUT, 1);
      expect(revised).toBe("A better draft about 402s.");
      expect(calls[0]?.prompt).toContain("Say what to do about it.");
    });

    test("trims what the model returned, since it goes on to be the output", async () => {
      model("\n  A better draft.  \n");
      expect(await reviseDraft("A draft.", CRITIQUE, INPUT, 1)).toBe("A better draft.");
    });
  });
});

/**
 * The loop, against a real durable engine.
 *
 * `runWorkflow` starts the workflow the agent declares under `"redline"` — the
 * name the page starts a run by — on the engine `aai dev` uses, over an
 * in-memory journal, and drives one delivery at a time. The desk has no
 * suspension, so what these assert is the OTHER durable property: a loop whose
 * exit is decided at run time, on a step's journaled verdict, and which
 * therefore has to take the same branch on every walk.
 *
 * The model is the whole world here, so the scripted replies ARE the run, and
 * the call log is what proves a replay did not pay for a round twice. Scripted
 * in body order, with the last reply repeating.
 */
describe("the run is DURABLE", () => {
  const BRIEF = {
    brief: "Explain why a 402 is the interesting status code for an agent to meet.",
    audience: "engineers" as const,
    mustCover: [],
  };
  const SHIP = '{"verdict":"ship","score":9,"notes":[]}';
  const REVISE = '{"verdict":"revise","score":5,"notes":["thin in the middle"]}';

  test("stops on the CRITIC's verdict, and journals one step per call site reached", async () => {
    const calls = model(["A draft about 402s.", SHIP]);
    const run = await runWorkflow(agentDef, "redline", { ...BRIEF, rounds: 3 });

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ shipped: true, roundsRun: 1 });
    // Two rounds of budget went unspent, so the journal holds one critique and
    // no revision at all — `(name, occurrence)` identity means the entries are
    // the record of which call sites the body actually reached.
    expect(stepKeys(run.steps)).toEqual(["critiqueDraft#0", "writeDraft#0"]);
    expect(calls).toHaveLength(2);
  });

  test("starts at the CRITIQUE when a draft came attached, and journals which way in", async () => {
    // The branch is on the INPUT, so the journal is the record of it: the walk
    // reached `acceptDraft`, never `writeDraft`, and did so without spending a
    // model call — the desk's first is the critique.
    const calls = model([SHIP]);
    const run = await runWorkflow(agentDef, "redline", { ...BRIEF, rounds: 3, source: ATTACHED });

    expect(run.status).toBe("completed");
    expect(stepKeys(run.steps)).toEqual(["acceptDraft#0", "critiqueDraft#0"]);
    expect(calls).toHaveLength(1);
    // The piece is the author's own file, and the output says whose.
    expect(run.output).toMatchObject({ draft: ATTACHED.text.trim(), source: "over-budget.md" });
  });

  test("takes the same way in on the walk after a crash, because the input is journaled", async () => {
    // The cheap half of the replay rule, next to the paid one below: a branch on
    // the input needs no journaled RESULT to be stable, because the input is the
    // same object on every walk. What a resume must not do is change its mind
    // and go looking for a `writeDraft#0` this run never wrote.
    const calls = model([REVISE, "A better draft.", SHIP]);
    const run = await runWorkflow(
      agentDef,
      "redline",
      { ...BRIEF, rounds: 3, source: ATTACHED },
      { crashAt: "reviseDraft" },
    );
    expect(run.crashed).toBe(true);
    expect(stepKeys(run.steps)).toEqual(["acceptDraft#0", "critiqueDraft#0"]);

    await run.restart();
    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ source: "over-budget.md" });
    // Three calls for three call sites that make one: the resume re-issued the
    // revision and the second critique, and `acceptDraft` was never a call at all.
    expect(calls).toHaveLength(3);
    expect(stepKeys(run.steps)).toEqual([
      "acceptDraft#0",
      "critiqueDraft#0",
      "critiqueDraft#1",
      "reviseDraft#0",
    ]);
  });

  test("a file with nothing in it fails the run rather than quietly writing one", async () => {
    // `acceptDraft` asks for ONE attempt, so a fatal guard is the whole story:
    // the run fails, and the journal shows the desk never fell back to writing.
    const calls = model(["nothing should ask for this"]);
    const run = await runWorkflow(agentDef, "redline", {
      ...BRIEF,
      rounds: 3,
      source: { name: "empty.md", text: " ".repeat(MIN_DRAFT_CHARS + 5) },
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("empty.md");
    expect(stepKeys(run.steps)).toEqual(["acceptDraft#0"]);
    expect(calls).toHaveLength(0);
  });

  test("journals a round per iteration, so `critiqueDraft#1` is round two", async () => {
    // Revise, revise, then ship: the loop runs to its budget of three.
    const calls = model([
      "A draft about 402s.",
      REVISE,
      "A better draft.",
      REVISE,
      "A better draft still.",
      SHIP,
    ]);
    const run = await runWorkflow(agentDef, "redline", { ...BRIEF, rounds: 3 });

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ roundsRun: 3 });
    expect(stepKeys(run.steps)).toEqual([
      "critiqueDraft#0",
      "critiqueDraft#1",
      "critiqueDraft#2",
      "reviseDraft#0",
      "reviseDraft#1",
      "writeDraft#0",
    ]);
    expect(calls).toHaveLength(6);
  });

  test("a worker that dies mid-round replays the finished rounds instead of re-writing them", async () => {
    // The claim the module doc makes: "a rate limit in round three replays
    // rounds one and two from the journal for free and re-issues only the call
    // that failed."
    const calls = model(["A draft about 402s.", REVISE, "A better draft.", SHIP]);
    const run = await runWorkflow(
      agentDef,
      "redline",
      { ...BRIEF, rounds: 3 },
      { crashAt: "reviseDraft" },
    );

    expect(run.crashed).toBe(true);
    expect(stepKeys(run.steps)).toEqual(["critiqueDraft#0", "writeDraft#0"]);
    expect(calls).toHaveLength(2);

    await run.restart();
    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ shipped: true });
    // Four calls in total for a run that reached four call sites — so the
    // resume paid for the revision and the second critique and NOT for the
    // draft or the first critique, which came back out of the journal.
    expect(calls).toHaveLength(4);
    expect(stepKeys(run.steps)).toEqual([
      "critiqueDraft#0",
      "critiqueDraft#1",
      "reviseDraft#0",
      "writeDraft#0",
    ]);
  });

  test("takes the SAME branch on the walk after a crash, because the verdict is journaled", async () => {
    // The replay-stability claim itself. The critic said "ship" on the first
    // walk; the model is then scripted to say "revise" to anything asked
    // afterwards. A body that re-decided the loop on a fresh model call would
    // carry on revising — a body that reads its journaled verdict cannot.
    const calls = model(["A draft about 402s.", SHIP, REVISE]);
    const run = await runWorkflow(
      agentDef,
      "redline",
      { ...BRIEF, rounds: 3 },
      { crashAt: "critiqueDraft" },
    );
    // Crashed BEFORE the critique's body ran, so nothing is journaled but the
    // draft — and the resume is what reaches the verdict.
    expect(run.crashed).toBe(true);
    expect(stepKeys(run.steps)).toEqual(["writeDraft#0"]);

    await run.restart();
    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ shipped: true, roundsRun: 1 });
    // Two calls: the draft, and the critique the crash cost. The third scripted
    // reply — the one that would have kept the loop going — is never asked for,
    // because the loop read its verdict out of the journal.
    expect(calls).toHaveLength(2);
  });
});
