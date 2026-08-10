// Copyright 2026 the AAI authors. MIT license.
/**
 * Durable workflows: a voice agent that hands off work outliving the call.
 *
 * The shape to copy is the seam between the two halves. A `tool()` runs inside
 * one turn and must answer the caller now; a `workflow()` is journaled, so it
 * survives the end of the session and the sandbox that started it. So the tool
 * does not do the research — it STARTS a run and reports the id, which is why
 * the caller can hang up immediately.
 *
 * Requires storage (`aai storage enable`, or DATABASE_URL under `aai dev`):
 * the run journal is what makes any of this durable.
 */

import { agent, tool, workflow } from "@alexkroman1/aai";
import { z } from "zod";

/** One digest row, as both the workflow and the read tool see it. */
const DigestRow = z.object({ topic: z.string(), body: z.string() });

const CREATE_TABLE = `create table if not exists digests (
  id bigserial primary key,
  topic text not null,
  body text not null,
  created_at timestamptz not null default now()
)`;

/**
 * Research a topic, wait, then write the result.
 *
 * Every unit of work is a `ctx.step`, and that is the whole discipline: a step
 * that has succeeded is never re-run, so when this resumes — after the sleep,
 * or after the sandbox it started on went away — the LLM call above is not paid
 * for twice. The `sleep` between them is durable: nothing is held open for it,
 * and it is deliberately longer than any single sandbox's life to make the
 * point.
 */
const digest = workflow({
  description: "Research a topic, then store a digest of it",
  input: z.object({ topic: z.string().min(1) }),
  async run({ topic }, ctx) {
    const body = await ctx.step("research", async () => {
      const { text } = await ctx.generate({
        prompt: `Write a tight five-sentence briefing on: ${topic}`,
      });
      return text;
    });

    // Let the news settle before recording it. A caller who asks in the
    // morning gets an answer built this afternoon.
    await ctx.sleep(60_000);

    await ctx.step("save", async () => {
      await ctx.db.query(CREATE_TABLE);
      await ctx.db.query("insert into digests (topic, body) values ($1, $2)", [topic, body]);
      // Steps journal their return value, so return something SMALL and
      // JSON-serializable — never the whole row set.
      return { saved: true };
    });

    return { topic, characters: body.length };
  },
});

export default agent({
  name: "Nightly Digest",
  voice: "vera",
  greeting: "Hi! Tell me a topic and I'll research it in the background.",
  systemPrompt: [
    "You are a research assistant who takes topics and works on them offline.",
    "When the caller names a topic, call start_digest and tell them it is",
    "running — do NOT wait for it or promise to stay on the line.",
    "If they ask how a run is going, call check_digest with the run id.",
    "If they ask what you have already written up, call read_digest.",
    "Keep replies to one or two sentences; this is a phone call.",
  ].join(" "),

  workflows: { digest },

  tools: {
    start_digest: tool({
      description: "Start background research on a topic. Returns a run id.",
      inputSchema: z.object({ topic: z.string().describe("What to research") }),
      // Resolves as soon as the run is journaled — the run itself keeps going
      // after this turn, and after the call.
      execute: async ({ topic }, ctx) => {
        const runId = await ctx.workflows.start("digest", { topic });
        return { runId, status: "started" };
      },
    }),

    check_digest: tool({
      description: "Check how a background research run is doing.",
      inputSchema: z.object({ runId: z.string().describe("Run id from start_digest") }),
      execute: async ({ runId }, ctx) => {
        const run = await ctx.workflows.get(runId);
        if (!run) return { error: `No run with id ${runId}` };
        // `stepsCompleted` is the only progress signal a workflow gives for
        // free; it is enough to say "still working" without inventing detail.
        return { status: run.status, stepsCompleted: run.stepsCompleted, error: run.error };
      },
    }),

    read_digest: tool({
      description: "Read back a digest that has already been written.",
      inputSchema: z.object({ topic: z.string() }),
      execute: async ({ topic }, ctx) => {
        await ctx.db.query(CREATE_TABLE);
        const rows = await ctx.db.query<z.infer<typeof DigestRow>>(
          "select topic, body from digests where topic = $1 order by created_at desc limit 1",
          [topic],
        );
        const row = rows[0];
        return row ? row : { error: `Nothing written up for ${topic} yet` };
      },
    }),
  },
});
