/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` and
 * `system-prompt.md` declare. `./agent.ts` would be the wrong import: the
 * authored export has NO tools and the framework-default prompt, so an eval
 * driving it would measure a different agent than the one that deploys.
 */
import agentDef from "virtual:aai/agent";
import type { SessionEvent } from "@alexkroman1/aai";
import {
  createRecordingWorkflows,
  customEventsIn,
  describeEval,
  type EvalTestContext,
  type EvalTurn,
  type RecordingWorkflows,
  toolArgsIn,
  toolNames,
  toolResultIn,
} from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

// EVALS: does the home assistant hand the after-the-conversation jobs to the right tool,
// and say what system-prompt.md says it should? Run with `aai eval`.
//
// agent.test.ts drives every tool and workflow against stubs and never calls a model.
// These drive a real session (the real runtime, tool executor, tools and system prompt)
// with only the durable runs faked: every start is RECORDED by the case's workflow
// client instead of run, so no reminder or research body ever executes.
//
//   aai eval                  LIVE when a provider key is set: spends tokens, and a model
//                             is a noisy instrument, so one failure is a question.
//   AAI_EVAL_STUB=1 aai eval  SCRIPTED: each case's `stubReply` plays the model. The
//                             wiring really runs but proves nothing about what it chooses.
//
// Every case passes in both modes; an assertion that only means something live sits
// under `if (mode === "live")`. The cases touch no network on purpose: in stub mode the
// tools really execute, so a weather case would call Open-Meteo from every `pnpm check`.

/** The speaker's ?client= id: without one every reminder tool refuses. */
const SPEAKER = "kitchen";

/**
 * A workflow client that RECORDS starts rather than running any body, fresh for every
 * case. cancel_reminders' `cancelAll` is answered from the recorded runs.
 */
function workflows(): RecordingWorkflows {
  const recording = createRecordingWorkflows({ workflows: agentDef.workflows });
  const cancelAll = (async (workflow: string, key: string) => {
    let cancelled = 0;
    for (const run of await recording.find(workflow, key)) {
      if (run.status !== "pending" && run.status !== "running") continue;
      if (await recording.cancel(run.runId)) cancelled++;
    }
    return cancelled;
  }) as RecordingWorkflows["cancelAll"];
  return { ...recording, cancelAll };
}

/** A recorded start's input, as the tool passed it. */
const input = (start: ReturnType<RecordingWorkflows["started"]>[number] | undefined) =>
  start?.input as Record<string, unknown> | undefined;

const names = (turn: EvalTurn) => toolNames(turn.toolCalls);

type SpeakerContext = EvalTestContext & { readonly workflowClient: RecordingWorkflows };

describeEval(
  agentDef,
  (test) => {
    test(
      "a timer is a reminder in seconds, on this speaker",
      async ({ session, mode, workflowClient }: SpeakerContext) => {
        const before = Date.now();
        const turn = await session.say("Set a timer for ten minutes.");

        expect(names(turn)).toEqual(["remind_me"]);
        expect(toolArgsIn(turn.toolCalls, "remind_me")[0]).toMatchObject({ in_seconds: 600 });
        const run = input(workflowClient.started("remind")[0]);
        expect(run?.clientId).toBe(SPEAKER);
        expect(Number(run?.dueAt) - before).toBeGreaterThanOrEqual(595_000);
        expect(Number(run?.dueAt) - before).toBeLessThanOrEqual(660_000);
        // LIVE ONLY: "Ten minutes, starting now."
        if (mode === "live") expect(turn.text).toMatch(/ten minutes|10 minutes/i);
      },
      {
        stubReply: [
          { tool: "remind_me", args: { text: "your timer", in_seconds: 600 } },
          "Ten minutes, starting now.",
        ],
      },
    );

    test(
      "a reminder at a clock time passes 24-hour `at` and confirms the time",
      async ({ session, workflowClient }: SpeakerContext) => {
        const turn = await session.say("Remind me to call the plumber at five PM.");

        expect(names(turn)).toEqual(["remind_me"]);
        const args = toolArgsIn(turn.toolCalls, "remind_me")[0];
        expect(args).toMatchObject({ at: "17:00" });
        expect(String(args?.text)).toMatch(/plumber/i);
        expect(workflowClient.started("remind")).toHaveLength(1);
        expect(turn.text).toMatch(/5|five/i);
      },
      {
        stubReply: [
          { tool: "remind_me", args: { text: "call the plumber", at: "17:00" } },
          "Okay, at 5 PM.",
        ],
      },
    );

    test(
      "a reminder set earlier in the conversation is the one cancelling cancels",
      async ({ session, workflowClient }: SpeakerContext) => {
        await session.say("Set a timer for five minutes.");
        expect(workflowClient.started("remind")).toHaveLength(1);
        const turn = await session.say("Actually, cancel my reminders.");

        expect(names(turn)).toEqual(["cancel_reminders"]);
        expect(workflowClient.cancelled).toHaveLength(1);
        expect(toolResultIn(turn.toolCalls, "cancel_reminders")).toEqual({ cancelled: 1 });
      },
      {
        stubReply: [
          { tool: "remind_me", args: { text: "your timer", in_seconds: 300 } },
          "Five minutes, starting now.",
          { tool: "cancel_reminders" },
          "Done, I cancelled it.",
        ],
      },
    );

    test(
      "research in depth is handed to a run, and the reply says how it will arrive",
      async ({ session, mode, workflowClient }: SpeakerContext) => {
        const turn = await session.say(
          "Can you do some deep research on heat pumps for a drafty old house?",
        );

        expect(names(turn)).toEqual(["deep_research"]);
        const run = input(workflowClient.started("research")[0]);
        expect(String(run?.topic)).toMatch(/heat pump/i);
        // Nothing is texted unasked.
        expect(run).toMatchObject({ clientId: SPEAKER, text: false });
        // LIVE ONLY: one sentence, and no promise of a text they didn't ask for.
        if (mode === "live") expect(turn.text).not.toMatch(/\btext/i);
      },
      {
        stubReply: [
          { tool: "deep_research", args: { topic: "heat pumps for a drafty old house" } },
          "I'm on it, and I'll tell you what I find right here in a few minutes.",
        ],
      },
    );

    test(
      "'stop' calls the stop tool and says nothing at all",
      async ({ session }: SpeakerContext) => {
        const turn = await session.say("Stop.");

        expect(names(turn)).toEqual(["stop"]);
        expect(customEventsIn(turn.events as SessionEvent[], "stop")).toHaveLength(1);
        // Not even "okay": the page has already hung up.
        expect(turn.text.trim()).toBe("");
      },
      { stubReply: [{ tool: "stop" }, ""] },
    );
  },
  {
    // The home's clock, so "at five PM" means the same thing on every machine.
    env: { TIME_ZONE: "America/Los_Angeles" },
    clientId: SPEAKER,
    workflows,
  },
);
