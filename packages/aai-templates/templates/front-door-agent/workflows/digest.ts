import { workflow } from "@alexkroman1/aai";
import {
  type ClientTranscript,
  DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
  stepClientTranscript,
  stepNotifyClient,
} from "@alexkroman1/aai/step";
import { z } from "zod";
import { CLIENT_ID, type DoorNotice } from "../shared.ts";

// "What happened at the door today?" The door's every conversation is kept by the runtime
// under its ?client= id, so this reads them back with stepClientTranscript, counts the
// visits and collects the messages left (each a leave_message call, with its arguments),
// and sends the phone one line. No model: it is counting, and a count must be right.

const digestInput = z.object({
  doorId: z.string().regex(CLIENT_ID),
  since: z.number().describe("Epoch ms: the start of the day being summarized"),
});

/** The day at the door in one line: how many visits, and every message left. */
export function digestOf(transcript: ClientTranscript): string {
  const visits = transcript.sessions.filter((s) => s.messages.some((m) => m.role === "user"));
  const messages = transcript.sessions.flatMap((s) =>
    s.tools.flatMap((call) =>
      call.name === "leave_message" && call.args !== undefined
        ? [`${String(call.args.name ?? "Someone")}: "${String(call.args.message ?? "")}"`]
        : [],
    ),
  );
  if (visits.length === 0) return "Nobody came to the door today.";
  const count = visits.length === 1 ? "One visit" : `${visits.length} visits`;
  if (messages.length === 0) return `${count} today, and no messages.`;
  return `${count} today. Messages: ${messages.join("; ")}.`;
}

export default workflow({
  description: "Summarize the day at the door and send it to the linked phone",
  input: digestInput,
  run: async (input, ctx) => {
    // The read is its own step, so a resumed run summarizes the same day it read.
    const transcript = await ctx.step("read", () =>
      stepClientTranscript(input.doorId, { since: input.since }),
    );
    const notice: DoorNotice = { kind: "digest", summary: digestOf(transcript) };
    await ctx.step(
      "notify",
      () => stepNotifyClient(input.doorId, { id: ctx.runId, event: "digest", data: notice }),
      { maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS },
    );
    return { summary: notice.summary };
  },
});
