import { tool, workflow } from "@alexkroman1/aai";
import { assemblyAI as assemblyAILlm } from "@alexkroman1/aai/llm";
import { slack } from "@alexkroman1/aai/send";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { generateStructured } from "@alexkroman1/aai/workflow";
import { z } from "zod";

// End-of-day voice debrief: one rambling clip in, several verified actions
// out. A field worker holds to talk (or uploads a recording) and says
// something like "finished the Hendersons' inspection, water heater needs
// replacing — quote them around $1,800, order the part, schedule a follow-up
// Thursday morning, and tell Mike the Oak Street job slips a day." One run:
//
//   transcript → extract_actions (generateStructured over ctx.generate turns
//   the disfluent ramble into TYPED actions, each carrying its assumptions)
//   → the loop executes each action with the matching tool (ctx.kv for
//   records, send_message for the Slack notification) → the run report
//   lists exactly what was filed, what was assumed, and what was skipped.
//
// This is the workflow app mode end to end: no conversation, no clarifying
// questions (missing values become skips with a reason, fuzzy values become
// stated assumptions), and the report is the audit trail.

/** One typed action extracted from the debrief. Flat with optional fields —
 *  a discriminated union would be prettier in TS, but this shape converts to
 *  the simplest JSON Schema for the structured-output call. */
const ActionSchema = z.object({
  type: z
    .enum(["quote", "order", "followup", "notify"])
    .describe(
      "quote = price quote for a customer; order = order a part or material; " +
        "followup = schedule a future visit or call; notify = message a teammate",
    ),
  summary: z.string().describe("One sentence: what this action is, in the speaker's words"),
  customer: z.string().optional().describe("Customer or job name, when stated"),
  amountUsd: z.number().optional().describe("Dollar amount for quotes, when stated"),
  part: z.string().optional().describe("Part or material to order, for order actions"),
  when: z.string().optional().describe("Date/time phrase for followups, as spoken"),
  message: z
    .string()
    .optional()
    .describe("For notify actions: the ready-to-send message, cleaned up but faithful"),
  assumptions: z
    .array(z.string())
    .describe("Every guess made — rounded amounts, inferred names, resolved self-corrections"),
});

const DebriefSchema = z.object({ actions: z.array(ActionSchema) });

const extractActions = tool({
  description:
    "Turn the raw debrief transcript into a typed list of actions (quote, order, " +
    "followup, notify). Call this FIRST, once, with the entire transcript.",
  parameters: z.object({
    transcript: z.string().describe("The full transcribed debrief, verbatim"),
  }),
  async execute({ transcript }, ctx) {
    // generateStructured converts the Zod schema to JSON Schema for the wire
    // (generation always runs on the host) and re-validates the result here.
    return await generateStructured(ctx.generate, DebriefSchema, {
      system:
        "You extract work actions from an end-of-day voice debrief. The " +
        "transcript is live speech: fillers, false starts, self-corrections. " +
        "Act on the speaker's FINAL intent. Never invent actions; list every " +
        "guess in that action's assumptions.",
      prompt: `Extract the actions from this debrief:\n\n${transcript}`,
    });
  },
});

/** Persist one record under a per-run key and hand back its id, so the run
 *  report can cite what was filed. */
async function fileRecord(
  ctx: { kv: { set(key: string, value: unknown): Promise<void> } },
  kind: string,
  record: Record<string, unknown>,
): Promise<{ id: string }> {
  const id = `${kind}:${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  await ctx.kv.set(id, { ...record, filedAt: new Date().toISOString() });
  return { id };
}

const fileQuote = tool({
  description: "File a price quote for a customer",
  parameters: z.object({
    customer: z.string().describe("Customer or job the quote is for"),
    amountUsd: z.number().describe("Quote amount in US dollars"),
    description: z.string().describe("What the quote covers"),
  }),
  async execute({ customer, amountUsd, description }, ctx) {
    const { id } = await fileRecord(ctx, "quote", { customer, amountUsd, description });
    return { filed: true, id, customer, amountUsd, description };
  },
});

const orderPart = tool({
  description: "Order a part or material",
  parameters: z.object({
    part: z.string().describe("The part or material to order"),
    forCustomer: z.string().optional().describe("Customer or job it is for, when known"),
  }),
  async execute({ part, forCustomer }, ctx) {
    const { id } = await fileRecord(ctx, "order", { part, forCustomer: forCustomer ?? null });
    return { ordered: true, id, part, forCustomer: forCustomer ?? null };
  },
});

const scheduleFollowup = tool({
  description: "Schedule a follow-up visit or call",
  parameters: z.object({
    customer: z.string().describe("Customer or job the follow-up is for"),
    when: z.string().describe("When, as spoken (e.g. 'Thursday morning')"),
    description: z.string().optional().describe("What the follow-up is about"),
  }),
  async execute({ customer, when, description }, ctx) {
    const { id } = await fileRecord(ctx, "followup", {
      customer,
      when,
      description: description ?? null,
    });
    return { scheduled: true, id, customer, when, description: description ?? null };
  },
});

export default workflow({
  name: "End-of-Day Debrief",
  // Layered onto the workflow base prompt (one-shot semantics, run report).
  systemPrompt:
    "The transcribed audio is an end-of-day field debrief containing several " +
    "actions. First call extract_actions once with the ENTIRE transcript. " +
    "Then execute every extracted action with the matching tool: quote → " +
    "file_quote, order → order_part, followup → schedule_followup, notify → " +
    "send_message (send exactly the action's message text). An action missing " +
    "a required value is skipped, never guessed into existence. The run " +
    "report must have one line per extracted action — filed/ordered/" +
    "scheduled/sent with the key values and record id, ASSUMED for each " +
    "assumption carried through, or SKIPPED with the missing value named.",
  greeting:
    "Hold to talk or upload your end-of-day debrief, then press Go — I will file the " +
    "quotes, orders, and follow-ups, and message the team.",
  stt: assemblyAI({ model: "universal-3-5-pro" }),
  llm: assemblyAILlm({ model: "gemini-2.5-flash-lite" }),
  tools: {
    extract_actions: extractActions,
    file_quote: fileQuote,
    order_part: orderPart,
    schedule_followup: scheduleFollowup,
  },
  send: slack(),
});
