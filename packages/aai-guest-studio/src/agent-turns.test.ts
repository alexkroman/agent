// Copyright 2026 the AAI authors. MIT license.
// The studio coding agent at the AGENT level, driven by the SDK's own testing
// framework: `runTextAgent` + `scriptedTextModel`
// (`@alexkroman1/aai-runtime/testing`).
//
// This closes a real gap rather than adding a layer. The package tested the
// coding agent from both ends and never in the middle:
//
//   studio/agent.test.ts             what the DEFINITION declares
//   studio/tools.test.ts             the studio-shaped half of the tool set
//   studio/chat.scenario.test.ts     the HTTP SURFACE, over a real port and disk
//   studio/agent.eval.test.ts        a LIVE model over a real workspace
//
// What none of them drives is one TURN of `createTextAgent` over
// `createStudioAgent`'s definition with a scripted model — the loop that owns
// argument coercion, Standard Schema validation, the `ctx` a tool is handed,
// the reserved final-answer step, and the event stream. `runTextAgent` is the
// framework's driver for exactly that ("that is right for a SPEC: one turn, no
// carry-over, the provider socket the only fake"), and until this file no
// shipped agent in the repo used it — the coding agent being the only text
// agent there is.
//
// TIER: unit, and it stays there by choice of TOOL. `todo_write` is the one
// studio tool that closes over nothing and touches no disk, so every claim
// below is made in memory. A turn that writes files is the scenario tier's, and
// `studio/chat.scenario.test.ts` already drives one end to end.

import { saidIn, toolCallsInEvents, toolNames } from "@alexkroman1/aai-runtime/eval";
import { runTextAgent } from "@alexkroman1/aai-runtime/testing";
import { describe, expect, test } from "vitest";
import { createStudioAgent, STUDIO_TOOL_TIMEOUT_MS, type StudioAgentDeps } from "./agent.ts";
import type { StudioSession } from "./session.ts";

/**
 * A session whose workspace is never touched.
 *
 * `createStudioAgent` performs no I/O — the tools close over `dir` and only
 * reach it when CALLED — so a path that does not exist is the honest fixture
 * for a suite that calls none of them. A real directory here would invite a
 * disk-touching claim into the unit tier.
 */
const session: StudioSession = {
  scope: "test-scope",
  project: "proj",
  files: {},
  apiKey: "caller-key-123",
  chatToken: "chat-token",
  system: "You are a coding agent.",
  model: "fake-1",
  maxSteps: 4,
  dir: "/nonexistent/studio-agent-turns",
};

const deps: StudioAgentDeps = {
  loadBundle: () => Promise.resolve({ config: { name: "A", toolSchemas: [] } }),
  executeTool: (name) => Promise.resolve(`ran ${name}`),
  // A clean check without spawning tsc — the post-write diagnostics are
  // `studio/write-diagnostics.test.ts`'s subject and a dependency here.
  typecheck: () => Promise.resolve({ ok: true, skipped: false }),
};

const codingAgent = () => createStudioAgent(session, deps);

/** The turn options a deployed studio turn runs with — see `studio/chat.ts`. */
const asDeployed = {
  // `ctx.env` stays EMPTY while the caller's key resolves the model. Reproduced
  // rather than defaulted, because it is the credential split this agent's
  // whole tool surface depends on.
  env: {},
  toolTimeoutMs: STUDIO_TOOL_TIMEOUT_MS,
  sessionId: `${session.scope}/${session.project}`,
} as const;

/** A well-formed `todo_write` plan, as the model would send it. */
const PLAN = {
  todos: [
    { content: "read agent.ts", status: "completed" },
    { content: "add the tool", status: "in_progress" },
    { content: "run test_agent", status: "pending" },
  ],
};

describe("one turn of the studio coding agent", () => {
  test("runs the tool the model chose and hands its result back to the model", async () => {
    const run = await runTextAgent(codingAgent(), "plan the work, then tell me the plan", {
      ...asDeployed,
      script: [
        { text: "Planning first.", toolCalls: [{ name: "todo_write", input: PLAN }] },
        { text: "Three steps: read, add, test." },
      ],
    });

    // The call really went through the executor: the ARGUMENTS are the SDK's
    // own parsed object, not the wire string, which is what says coercion and
    // Standard Schema validation ran on the way in.
    expect(run.toolCalls.map((call) => call.name)).toEqual(["todo_write"]);
    expect(run.toolCalls[0]?.args).toEqual(PLAN);
    // And the RESULT is the tool's own rendering — the thing the model reads on
    // the next step. `todo_write` answers a marked list plus a remaining count.
    expect(String(run.toolCalls[0]?.result)).toContain("add the tool");
    expect(String(run.toolCalls[0]?.result)).toMatch(/\d+ remaining/);
    // `text` is joined ACROSS steps, which is the field a spec wants: the
    // narration before a tool call lives in an earlier step, and
    // `StreamTextResult.text` would report only the sentence after it.
    expect(run.text).toBe("Planning first.Three steps: read, add, test.");
    expect(run.texts).toHaveLength(2);
  });

  test("a tool argument the schema rejects arrives as a result, never as a throw", async () => {
    // The property the studio depends on and cannot get from `execute`
    // directly: an LLM-supplied argument that fails validation has to reach the
    // model as text it can repair from, because the alternative is a turn that
    // dies on the model's typo. The studio's model "regularly emits a whole
    // source file inside a JSON string", so this path is load-bearing here
    // rather than theoretical.
    const run = await runTextAgent(codingAgent(), "plan the work", {
      ...asDeployed,
      script: [
        { toolCalls: [{ name: "todo_write", input: { todos: "read agent.ts" } }] },
        { text: "Let me send that as a list." },
      ],
    });

    const rejected = String(run.toolCalls[0]?.result);
    expect(rejected, rejected).toMatch(/error/i);
    // It names the field, which is the half that makes it repairable.
    expect(rejected).toContain("todos");
    // The turn SURVIVED it and went on to say something.
    expect(run.text).toBe("Let me send that as a list.");
  });

  test("the step budget reserves a final answering step, with tools off", async () => {
    // The one behaviour that CHANGED when the coding agent moved onto the SDK,
    // and nothing pinned it for this definition. `stopWhen: stepCountIs(n)`
    // alone ended a capped turn wherever the budget ran out — including
    // straight after a tool result, with nothing said — and that turn completed
    // SUCCESSFULLY, so the user saw the agent simply stop. The budget is
    // `maxSteps + 1` with `toolChoice: "none"` forced on the extra step, so the
    // reserved step still has every tool result in context and no move left but
    // to answer.
    //
    // The script would call a tool on every step if it were allowed to: the
    // assertion is that the LAST step called none and spoke anyway.
    const run = await runTextAgent(codingAgent(), "keep planning forever", {
      ...asDeployed,
      maxSteps: 1,
      script: [
        { toolCalls: [{ name: "todo_write", input: PLAN }] },
        { text: "Stopping here — the plan is written." },
      ],
    });

    expect(run.steps).toHaveLength(2);
    expect(run.toolCalls.map((call) => call.name)).toEqual(["todo_write"]);
    expect(run.texts.at(-1)).toBe("Stopping here — the plan is written.");
    // The reserved step is the one that answers, so the turn never ends on a
    // tool result with nothing said.
    expect(run.text).not.toBe("");
  });

  test("the turn is a SessionEvent stream the eval readers take unchanged", async () => {
    // The bridge the framework documents and this package had never used: a
    // text agent emits the same narrowed `SessionEvent` union a voice session
    // does, so the same three readers grade a coding-agent turn and a template
    // agent's turn. That is what makes `studio/agent.eval.test.ts` possible at
    // all, and it is asserted here — against a script, with no key and no
    // model — rather than only where it costs tokens to find out.
    const run = await runTextAgent(codingAgent(), "plan the work", {
      ...asDeployed,
      script: [
        { text: "Planning.", toolCalls: [{ name: "todo_write", input: PLAN }] },
        { text: "Done." },
      ],
    });

    expect(toolNames(toolCallsInEvents(run.events))).toEqual(["todo_write"]);
    // A text turn commits its reply ONCE, joined across steps — where a voice
    // session commits per utterance. That difference is a property of the MODE,
    // and a case ported between the two harnesses meets it first.
    expect(saidIn(run.events)).toEqual(["Planning.Done."]);
    // Exactly one terminator, which is what lets a harness wait for a reply to
    // END rather than for a timer.
    const terminators = run.events.filter(
      (event) => event.type === "reply.completed" || event.type === "reply.cancelled",
    );
    expect(terminators).toHaveLength(1);
    expect(terminators[0]?.type).toBe("reply.completed");
  });
});
