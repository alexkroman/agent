import { type WorkflowContext, workflow } from "@alexkroman1/aai";
import { DEFAULT_CLIENT_DELIVERY_ATTEMPTS, stepNotifyClient } from "@alexkroman1/aai/step";
import { z } from "zod";
import { CLIENT_ID, type DoorNotice } from "../shared.ts";

// Tell the door's linked phone something happened at the door: a visitor left a message,
// or the hardware bell rang. The phone holds the DOOR's inbox (it is the door's twin), so
// the notice goes to the door's client id and reaches whichever phone is listening.
//
// stepNotifyClient with no audio: the phone shows it, there is nothing to say. It resolves
// when the phone acks; a phone that is off, or busy, throws a retryable
// ClientUnreachableError, and the step's attempts are the redelivery: an hour's worth, so a
// phone in a pocket on a train still hears about it when it is back.

const announceInput = z.object({
  doorId: z.string().regex(CLIENT_ID),
  notice: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("visitor"), name: z.string(), message: z.string() }),
    z.object({ kind: z.literal("ring") }),
  ]),
});

/** The body: one step, whose attempts are the redelivery. */
export async function announceFlow(input: z.infer<typeof announceInput>, ctx: WorkflowContext) {
  const notice: DoorNotice = input.notice;
  await ctx.step(
    "notify",
    () => stepNotifyClient(input.doorId, { id: ctx.runId, event: notice.kind, data: notice }),
    { maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS },
  );
  return { told: true };
}

export default workflow({
  description: "Tell the door's linked phone about a visitor or a ring",
  input: announceInput,
  run: announceFlow,
});
