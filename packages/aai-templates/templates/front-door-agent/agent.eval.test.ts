// An EVAL: does the door take a visitor's message and pass it on, once, in their words,
// without saying anything about the household? Run it with `aai eval`.
//
// The session carries the door's ?client= id (`clientId` below): without one, a door has
// nobody to pass a message to and leave_message refuses. The runs it starts are recorded,
// not run, so the case reads what the tool handed the `announce` workflow.
//
// Without a provider key every case runs against a SCRIPTED model (its `stubReply`): the
// real session and the real tool, a fake reply. That proves the wiring and nothing about
// the choice.

import agentDef from "virtual:aai/agent";
import {
  createRecordingWorkflows,
  describeEval,
  type EvalTestContext,
  expectCalled,
  type RecordingWorkflows,
  toolArgsIn,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";
import leaveMessage from "./tools/leave_message.ts";

/** The door's ?client= id. */
const DOOR = "front-door";

type DoorContext = EvalTestContext & { readonly workflowClient: RecordingWorkflows };

describeEval(
  agentDef,
  (test) => {
    test(
      "a delivery driver's message is passed on to the owner",
      async ({ session, mode, workflowClient }: DoorContext) => {
        const turn = await session.say(
          "Hi, it's Sam from FedEx. I've left the parcel behind the green bin.",
        );
        expectCalled(turn, leaveMessage);
        expect(toolArgsIn(turn.toolCalls, leaveMessage)[0]?.message.toLowerCase()).toContain("bin");
        const started = workflowClient.started("announce");
        expect(started).toHaveLength(1);
        expect(started[0]?.input).toMatchObject({ doorId: DOOR, notice: { kind: "visitor" } });
        // LIVE ONLY: the visitor hears it was passed on.
        if (mode === "live") expect(turn.text).toMatch(/pass|let .* know|told/i);
      },
      {
        stubReply: [
          {
            tool: "leave_message",
            args: { name: "Sam from FedEx", message: "The parcel is behind the green bin." },
          },
          "Thanks Sam, I've passed that on.",
        ],
      },
    );
  },
  {
    clientId: DOOR,
    workflows: () => createRecordingWorkflows({ workflows: agentDef.workflows }),
  },
);
