import type { WorkflowContext } from "@alexkroman1/aai";

// A reminder: sleep until it is due, then say it on the speaker. The session that set it
// closed long ago, so it goes to the client's idle inbox socket (`WS /inbox?client=`, held
// open by the page's useInbox or a device's own). The step's retries are the redelivery: a
// speaker that is offline or mid-conversation gets it when it can take it.
//
// ctx.sayOnClient is that one step: it speaks the text, pushes the audio, and uses the run
// id as the notice id (a redelivery after a lost ack is a repeat the client drops, not a
// second reminder), with DEFAULT_CLIENT_DELIVERY_ATTEMPTS as its budget.

export type RemindInput = { clientId: string; text: string; dueAt: number };

export async function remindFlow(input: RemindInput, ctx: WorkflowContext) {
  // A duration from the JOURNALED clock: ctx.now() answers every replay with the first
  // walk's time, so a resumed run waits for the same instant rather than drifting.
  const now = await ctx.now();
  await ctx.sleep("due", Math.max(0, input.dueAt - now));
  await ctx.sayOnClient("deliver", input.clientId, {
    event: "reminder",
    text: `Reminder: ${input.text}`,
    data: { text: input.text },
  });
  return { delivered: true };
}
