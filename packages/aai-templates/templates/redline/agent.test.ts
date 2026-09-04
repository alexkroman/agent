/**
 * Specs for the redline desk — the reflection port, as a workflow app.
 *
 * The declaration is testable (three things that are silent when wrong — the
 * `page: "static"` field, the workflow's name, and the input schema) and so are
 * the STEPS, which imported with no bundler in the path are ordinary async
 * functions: their JSON contract with the model, their `FatalError` guards, and
 * the pure helpers underneath them.
 *
 * **And so is the loop's EXIT**, which this file used to name as the one thing a
 * spec here could not reach: "it is decided in the body, on a step's journaled
 * verdict, and what would prove it is a replay, which needs a built world."
 * There is no built world any more — `runWorkflow`
 * (`@alexkroman1/aai-runtime/testing`) runs this body on the real replay engine
 * over an in-memory journal. The last block below is that claim, asserted the
 * only way it can be: crash the desk mid-round, hand the journal to a fresh
 * engine, and count the model calls the resume did NOT make.
 */

import { FatalError } from "@alexkroman1/aai/step-errors";
import { parseSchemaInput, schemaInputIssues } from "@alexkroman1/aai/testing";
import { installStubGateway as stubGateway } from "@alexkroman1/aai/testing/vitest";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import agentDef, { MAX_ROUNDS, redline } from "./agent.ts";
import {
  briefBlock,
  clampScore,
  critiqueDraft,
  MAX_NOTES,
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

// ─── 1. The declaration ──────────────────────────────────────────────────────

describe("the agent declares itself a workflow app", () => {
  test("under the name the page starts a run by", () => {
    // `useWorkflowSubmit("redline")` in client.tsx names this key. Nothing else
    // records it, so a rename here is a 400 there rather than a compile error.
    // `toContain` rather than an exact key list: adding a second workflow is an
    // invited edit and must not redden a test the author did not write. The
    // NAME is still pinned, deliberately — the page starts a run by this
    // string, so renaming the key is a runtime 400 rather than a compile
    // error, and this pin is the only thing that says so. Rename it here and
    // in `client.tsx` together.
    expect(Object.keys(agentDef.workflows ?? {})).toContain("redline");
    expect(agentDef.workflows?.redline).toBe(redline);
  });

  test("and declares the credential its steps read", () => {
    // A workflow app declares no providers, so `requiredEnv` is the ONLY thing
    // in its config that can name a credential.
    expect(agentDef.requiredEnv).toContain("ASSEMBLYAI_API_KEY");
  });
});

describe("the input schema", () => {
  // `schemaInputIssues` / `parseSchemaInput` rather than a local reach through
  // `["~standard"].validate`: that is the vendor WIRE contract, and whether it
  // answers synchronously or with a promise is the vendor's business — a missing
  // `await` there leaves `.issues` undefined and every refusing test below
  // passes for the wrong reason.
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

  test("declares mustCover as an array, which is what the page renders by hand", async () => {
    // The mixed-form case: `<WorkflowFields>` renders scalars only, so client.tsx
    // writes this field itself and maps a textarea into it.
    expect(await issues({ ...INPUT, mustCover: "one point" })).toBeDefined();
    expect(await issues({ ...INPUT, mustCover: ["one point"] })).toBeUndefined();
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
  beforeEach(() => {
    // `stepEnv` falls back to the process env when no host has published one,
    // which is exactly the case a spec is. `unstubEnvs` clears it per test.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  describe("writeDraft", () => {
    test("returns the piece the model wrote, trimmed", async () => {
      const calls = stubGateway("\n  A draft about 402s.  \n");
      expect(await writeDraft(INPUT)).toBe("A draft about 402s.");
      // The brief reaches the writer — otherwise it writes something else well.
      expect(calls[0]?.prompt).toContain("how to raise the cap");
    });

    test("fails FATALLY on a brief that is only whitespace", async () => {
      // The schema's `.min(20)` counts CHARACTERS, so twenty spaces validate at
      // `start()` and arrive here as nothing to write from. No number of
      // attempts makes a brief longer, so it is fatal rather than retryable.
      stubGateway("unused");
      await expect(writeDraft({ ...INPUT, brief: " ".repeat(25) })).rejects.toThrow(/too short/);
    });

    test("lets the SDK refuse an empty completion, RETRYABLY", async () => {
      // Neither writer step carries an empty-reply guard, because `stepGenerate`
      // already has one — and its verdict is the one that matters: retryable, so
      // a blank answer costs an attempt rather than the run. A hand-written
      // check here would have to re-derive that and could get it wrong.
      stubGateway("   ");
      const failure = await writeDraft(INPUT).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(FatalError);
      expect(String(failure)).toMatch(/empty completion/);
    });
  });

  describe("critiqueDraft", () => {
    test("returns the verdict the body branches on, with the score clamped", async () => {
      stubGateway('{"verdict":"ship","score":42,"notes":["nothing major"]}');
      const critique = await critiqueDraft("A draft.", INPUT, 1);
      expect(critique.verdict).toBe("ship");
      expect(critique.score).toBe(10);
    });

    test("keeps at most the notes the prompt asked for", async () => {
      const notes = JSON.stringify(["a", "b", "c", "d", "e"]);
      stubGateway(`{"verdict":"revise","score":6,"notes":${notes}}`);
      const critique = await critiqueDraft("A draft.", INPUT, 1);
      expect(critique.notes).toHaveLength(MAX_NOTES);
    });

    test("unwraps a fenced reply rather than failing on it", async () => {
      stubGateway('```json\n{"verdict":"revise","score":5,"notes":["thin"]}\n```');
      expect((await critiqueDraft("A draft.", INPUT, 1)).notes).toEqual(["thin"]);
    });

    test("throws PLAINLY when the critic answered with prose, so the step retries", async () => {
      // The distinction that is the whole retry policy: a model that ignored the
      // format may well obey on the next attempt, where a 401 will not. Plain
      // means NOT a `FatalError`, which is what the DevKit stops retrying on.
      stubGateway("I think the draft is pretty good, honestly.");
      const err = await critiqueDraft("A draft.", INPUT, 1).catch((thrown: unknown) => thrown);

      expect(FatalError.is(err)).toBe(false);
      expect((err as Error).message).toMatch(/Expected JSON from the model/);
    });

    test("rejects a verdict outside the two the loop understands", async () => {
      // Anything else would be read as "not ship" and quietly cost a round. The
      // schema NAMES the field, which the hand-written guard this replaced could
      // not: it answered a bare false.
      stubGateway('{"verdict":"looks fine","score":8,"notes":[]}');
      await expect(critiqueDraft("A draft.", INPUT, 1)).rejects.toThrow(
        /did not match the shape: verdict/,
      );
    });
  });

  describe("reviseDraft", () => {
    const CRITIQUE = { verdict: "revise" as const, score: 5, notes: ["Say what to do about it."] };

    test("sends the notes to the reviser and returns the revision", async () => {
      const calls = stubGateway("A better draft about 402s.");
      const revised = await reviseDraft("A draft.", CRITIQUE, INPUT, 1);
      expect(revised).toBe("A better draft about 402s.");
      expect(calls[0]?.prompt).toContain("Say what to do about it.");
    });

    test("trims what the model returned, since it goes on to be the output", async () => {
      stubGateway("\n  A better draft.  \n");
      expect(await reviseDraft("A draft.", CRITIQUE, INPUT, 1)).toBe("A better draft.");
    });
  });
});

/**
 * The loop, against a real durable engine.
 *
 * `runWorkflow` starts the declared workflow on the engine `aai dev` uses, over
 * an in-memory journal, and drives one delivery at a time. The desk has no
 * suspension, so what these assert is the OTHER durable property — the one this
 * module doc says is the shape neither sibling template has: a loop whose exit
 * is decided at run time, on a step's journaled verdict, and which therefore has
 * to take the same branch on every walk.
 *
 * The model is the whole world here (`writeDraft`, `critiqueDraft` and
 * `reviseDraft` are all `stepGenerate*OrFail`), so `stubGateway`'s scripted
 * replies ARE the run, and its call log is what proves a replay did not pay for
 * a round twice. Scripted in body order, with the last reply repeating.
 */
describe("the run is DURABLE", () => {
  const BRIEF = {
    brief: "Explain why a 402 is the interesting status code for an agent to meet.",
    audience: "engineers" as const,
    mustCover: [],
  };
  const SHIP = '{"verdict":"ship","score":9,"notes":[]}';
  const REVISE = '{"verdict":"revise","score":5,"notes":["thin in the middle"]}';

  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  test("stops on the CRITIC's verdict, and journals one step per call site reached", async () => {
    const model = stubGateway(["A draft about 402s.", SHIP]);
    const run = await runWorkflow(redline, { ...BRIEF, rounds: 3 }, { name: "redline" });

    expect(run.status).toBe("completed");
    expect(run.output?.shipped).toBe(true);
    expect(run.output?.roundsRun).toBe(1);
    // Two rounds of budget went unspent, so the journal holds one critique and
    // no revision at all — `(name, occurrence)` identity means the entries are
    // the record of which call sites the body actually reached.
    expect(run.steps.map((step) => step.key)).toEqual(["critiqueDraft#0", "writeDraft#0"]);
    expect(model).toHaveLength(2);
  });

  test("journals a round per iteration, so `critiqueDraft#1` is round two", async () => {
    // Revise, revise, then ship: the loop runs to its budget of three.
    const model = stubGateway([
      "A draft about 402s.",
      REVISE,
      "A better draft.",
      REVISE,
      "A better draft still.",
      SHIP,
    ]);
    const run = await runWorkflow(redline, { ...BRIEF, rounds: 3 }, { name: "redline" });

    expect(run.status).toBe("completed");
    expect(run.output?.roundsRun).toBe(3);
    expect(run.steps.map((step) => step.key)).toEqual([
      "critiqueDraft#0",
      "critiqueDraft#1",
      "critiqueDraft#2",
      "reviseDraft#0",
      "reviseDraft#1",
      "writeDraft#0",
    ]);
    expect(model).toHaveLength(6);
  });

  test("a worker that dies mid-round replays the finished rounds instead of re-writing them", async () => {
    // The claim the module doc makes and nothing could check: "a rate limit in
    // round three replays rounds one and two from the journal for free and
    // re-issues only the call that failed."
    const model = stubGateway(["A draft about 402s.", REVISE, "A better draft.", SHIP]);
    const run = await runWorkflow(
      redline,
      { ...BRIEF, rounds: 3 },
      { name: "redline", crashAt: "reviseDraft" },
    );

    expect(run.crashed).toBe(true);
    expect(run.steps.map((step) => step.key)).toEqual(["critiqueDraft#0", "writeDraft#0"]);
    const spentBeforeTheCrash = model.length;
    expect(spentBeforeTheCrash).toBe(2);

    await run.restart();
    expect(run.status).toBe("completed");
    expect(run.output?.shipped).toBe(true);
    // Four calls in total for a run that reached four call sites — so the
    // resume paid for the revision and the second critique and NOT for the
    // draft or the first critique, which came back out of the journal.
    expect(model).toHaveLength(4);
    expect(run.steps.map((step) => step.key)).toEqual([
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
    const model = stubGateway(["A draft about 402s.", SHIP, REVISE]);
    const run = await runWorkflow(
      redline,
      { ...BRIEF, rounds: 3 },
      { name: "redline", crashAt: "critiqueDraft" },
    );
    // Crashed BEFORE the critique's body ran, so nothing is journaled but the
    // draft — and the resume is what reaches the verdict.
    expect(run.crashed).toBe(true);
    expect(run.steps.map((step) => step.key)).toEqual(["writeDraft#0"]);

    await run.restart();
    expect(run.status).toBe("completed");
    expect(run.output?.shipped).toBe(true);
    expect(run.output?.roundsRun).toBe(1);
    // Two calls: the draft, and the critique the crash cost. The third scripted
    // reply — the one that would have kept the loop going — is never asked for,
    // because the loop read its verdict out of the journal.
    expect(model).toHaveLength(2);
  });
});
