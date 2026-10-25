// An EVAL: does Field Notes write down what was dictated — once, in the
// caller's words — and read it back when asked? Run it with `aai eval`.
//
// `agent.test.ts` settles what the two tools do with the arguments they are
// handed. What only a model can settle is whether a held turn becomes ONE
// `save_note` call carrying the whole note, rather than a reply to its first
// half. Each `session.say()` here is one press of the button: the harness
// frames it with the same `user_turn_start` / `user_turn_commit` pair the
// page's `usePushToTalk()` sends, because a `turnTaking: { detection: "manual" }` agent
// answers nothing that was not released.
//
// Without a provider key every case runs against a SCRIPTED model (its
// `stubReply`): the real session, the real slot, the real tools, a fake reply.
// That proves the wiring and nothing about the choice.

import agentDef from "virtual:aai/agent";
import { toolNameOf } from "@alexkroman1/aai-runtime/testing";
import {
  describeEval,
  expectCalled,
  lastStateIn,
  toolNames,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";
import { notebookSlot } from "./shared.ts";
import saveNote from "./tools/save_note.ts";

describeEval(agentDef, (test) => {
  test(
    "a dictated note is saved once, in the caller's words",
    async ({ session }) => {
      const turn = await session.say(
        "Unit four, the window seal in the kitchen is cracked and needs replacing before winter.",
      );
      // One note, one call: the whole press is one thought. The name is read
      // off the def, so a renamed file fails here rather than matching nothing.
      const saved = toolNameOf(saveNote);
      expectCalled(turn, saved);
      expect(toolNames(turn.toolCalls).filter((name) => name === saved)).toHaveLength(1);
      // The notebook as the PAGE has it: the last frame pushed, read through
      // the same projection `client.tsx` renders.
      const notes = lastStateIn(turn.events, notebookSlot.projected)?.notes ?? [];
      expect(notes).toHaveLength(1);
      expect(notes[0]?.text.toLowerCase()).toContain("window seal");
    },
    {
      stubReply: [
        {
          tool: "save_note",
          args: {
            text: "Unit four, the window seal in the kitchen is cracked and needs replacing before winter.",
          },
        },
        "Got it, note one.",
      ],
    },
  );

  test(
    "notes survive to the next press and are read back on request",
    async ({ session }) => {
      await session.say("Boiler in the basement reads one point two bar.");
      const turn = await session.say("What have I got so far?");
      expectCalled(turn, "list_notes");
      expect(turn.text.toLowerCase()).toContain("boiler");
    },
    {
      stubReply: [
        { tool: "save_note", args: { text: "Boiler in the basement reads one point two bar." } },
        "Saved.",
        { tool: "list_notes", args: {} },
        "One note: the boiler in the basement reads one point two bar.",
      ],
    },
  );
});
