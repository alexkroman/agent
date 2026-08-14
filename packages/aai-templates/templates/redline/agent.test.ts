/**
 * Specs for the redline desk — the reflection port, as a workflow app.
 *
 * Same honest line as `link-digest`'s spec, for the same reason: the workflow
 * BODY is only durable once the Workflow DevKit's build has transformed it, so
 * testing it here would exercise a plain async function and prove nothing about
 * replay. What IS testable is the declaration (three things that are silent when
 * wrong — the `page: "static"` field, the workflow's name, and the input schema)
 * and the STEPS, which imported with no bundler in the path are ordinary async
 * functions: their JSON contract with the model, their `FatalError` guards, and
 * the pure helpers underneath them.
 *
 * The loop's EXIT is the one thing worth naming that a spec here cannot reach.
 * It is decided in the body, on a step's journaled verdict — see the module doc
 * in `workflows/redline.ts` — and what would prove it is a replay, which needs a
 * built world. The critique step's verdict handling is where the testable half
 * of that lives.
 */

import { installStubGateway as stubGateway } from "@alexkroman1/aai/testing/vitest";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { FatalError } from "workflow";
import agentDef, { MAX_ROUNDS, redline } from "./agent.ts";
import {
  briefBlock,
  clampScore,
  countWords,
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
  test("its front door is a page, not a microphone", () => {
    // The port's own decision: seven long-form model calls in sequence is not
    // something anyone holds a phone for.
    expect(agentDef.page).toBe("static");
  });

  test("it declares no voice pipeline and no tools, because nothing talks", () => {
    expect(agentDef.stt).toBeUndefined();
    expect(agentDef.llm).toBeUndefined();
    expect(agentDef.tts).toBeUndefined();
    expect(agentDef.tools).toEqual({});
  });

  test("under the name the page starts a run by", () => {
    // `useWorkflowSubmit("redline")` in client.tsx names this key. Nothing else
    // records it, so a rename here is a 400 there rather than a compile error.
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["redline"]);
    expect(agentDef.workflows?.redline).toBe(redline);
  });

  test("and declares the credential its steps read", () => {
    // A workflow app declares no providers, so `requiredEnv` is the ONLY thing
    // in its config that can name a credential.
    expect(agentDef.requiredEnv).toContain("ASSEMBLYAI_API_KEY");
  });
});

describe("the input schema", () => {
  const validate = (value: unknown) => redline.input?.["~standard"].validate(value);

  test("caps the rounds at the CALL SITE rather than on the bill", async () => {
    const tooMany = await validate({ ...INPUT, rounds: MAX_ROUNDS + 1 });
    expect(tooMany?.issues).toBeDefined();
  });

  test("defaults the rounds and the required points, so the form need not", async () => {
    const result = await validate({ brief: INPUT.brief, audience: "engineers" });
    if (!result || result.issues) throw new Error("expected valid input");
    expect(result.value).toMatchObject({ rounds: 2, mustCover: [] });
  });

  test("rejects an audience outside the enum — which is also what makes it a select", async () => {
    // `<WorkflowFields>` renders a `z.enum` as a `<SelectField>`; the same
    // declaration is what stops an API caller inventing a fifth audience.
    expect((await validate({ ...INPUT, audience: "cats" }))?.issues).toBeDefined();
  });

  test("declares mustCover as an array, which is what the page renders by hand", async () => {
    // The mixed-form case: `<WorkflowFields>` renders scalars only, so client.tsx
    // writes this field itself and maps a textarea into it.
    expect((await validate({ ...INPUT, mustCover: "one point" }))?.issues).toBeDefined();
    expect((await validate({ ...INPUT, mustCover: ["one point"] }))?.issues).toBeUndefined();
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

  test("countWords ignores surrounding and repeated whitespace", () => {
    expect(countWords("  one  two\nthree ")).toBe(3);
    expect(countWords("   ")).toBe(0);
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
