// Copyright 2026 the AAI authors. MIT license.
/**
 * Durable workflows: a voice front desk over AssemblyAI's async transcription.
 *
 * This is the case durable steps exist for. Transcribing a recording is a
 * SUBMIT-THEN-POLL job that takes minutes — far longer than a tool call may run
 * (`TOOL_EXECUTION_TIMEOUT_MS`), and far longer than the caller will stay on the
 * line. So the tool does not transcribe: it starts a run and reads back a job
 * reference, and the workflow keeps polling after the call ends, on whatever
 * sandbox happens to be alive when each poll comes due.
 *
 * The shape worth copying is the POLL LOOP. Each poll is its own journaled step
 * and each wait is a durable `ctx.sleep`, so a resumed run replays the polls it
 * already made from the journal (no HTTP, no cost) and issues exactly one new
 * request — the loop reads as ordinary code while being crash-safe at every
 * iteration.
 *
 * Requires storage (`aai storage enable`, or DATABASE_URL under `aai dev`).
 */

import { agent, tool, workflow } from "@alexkroman1/aai";
import { z } from "zod";

const API = "https://api.assemblyai.com/v2/transcript";

/** Seconds between polls. Transcription is minutes-scale, so this is not a busy loop. */
const POLL_INTERVAL_MS = 10_000;

/**
 * Polls before the run gives up, bounding both the wait (~10 min) and the
 * journal. Two entries per iteration (the poll, the sleep) against the SDK's
 * 500-entry cap, so this leaves plenty of room.
 */
const MAX_POLLS = 60;

/** What `GET /v2/transcript/:id` tells us, narrowed to what this template reads. */
type TranscriptStatus = {
  status: "queued" | "processing" | "completed" | "error";
  text?: string | null;
  error?: string | null;
};

/** One stored transcript row. */
const TranscriptRow = z.object({
  job_id: z.string(),
  label: z.string(),
  summary: z.string(),
});

const CREATE_TABLE = `create table if not exists transcripts (
  id bigserial primary key,
  job_id text not null unique,
  label text not null,
  audio_url text not null,
  summary text not null,
  transcript text not null,
  created_at timestamptz not null default now()
)`;

/**
 * The streaming sockets and the REST API authenticate with the RAW key, not a
 * `Bearer` token — a detail that fails as a 401 rather than as a type error.
 */
function authHeaders(env: Readonly<Record<string, string>>): Record<string, string> {
  const key = env.ASSEMBLYAI_API_KEY;
  if (!key) throw new Error("ASSEMBLYAI_API_KEY is not set for this app");
  return { authorization: key, "content-type": "application/json" };
}

/**
 * Transcribe a recording, summarize it, and file the result.
 *
 * Every unit of work is a step, and the ORDER of the steps is fixed regardless
 * of what the polls return — which is what makes replay deterministic. The
 * decision that varies (keep polling or stop) is taken on values that came out
 * of a journaled step, never on a fresh clock reading.
 */
const transcribe = workflow({
  description: "Submit a recording to AssemblyAI, wait for it, then summarize and store it",
  input: z.object({
    audioUrl: z.string().url().describe("Publicly reachable URL of the recording"),
    label: z.string().default("untitled").describe("How the caller refers to this recording"),
  }),
  async run({ audioUrl, label }, ctx) {
    // The one step with an EXTERNAL side effect, and therefore the one to keep
    // small. AssemblyAI's API takes no idempotency key, so a crash in the window
    // between this POST returning and the journal write costs one duplicate
    // (billable) job on resume. That is the at-least-once tax in its most
    // concrete form: it cannot be designed away here, only bounded by putting
    // nothing else inside this step.
    const jobId = await ctx.step("submit", async () => {
      const resp = await fetch(API, {
        method: "POST",
        headers: authHeaders(ctx.env),
        // The URL came from the caller through the model; we hand it to
        // AssemblyAI and never fetch it ourselves, so it reaches no host here.
        body: JSON.stringify({ audio_url: audioUrl }),
        signal: ctx.signal,
      });
      if (!resp.ok) throw new Error(`submit failed: ${resp.status} ${await resp.text()}`);
      const { id } = (await resp.json()) as { id: string };
      return id;
    });

    // Poll until it settles. On a resume every completed poll below returns its
    // journaled answer instantly and only the next one hits the network.
    let transcript: string | undefined;
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      const status = await ctx.step("poll", async (): Promise<TranscriptStatus> => {
        const resp = await fetch(`${API}/${jobId}`, {
          headers: authHeaders(ctx.env),
          signal: ctx.signal,
        });
        if (!resp.ok) throw new Error(`poll failed: ${resp.status}`);
        return (await resp.json()) as TranscriptStatus;
      });

      if (status.status === "completed") {
        transcript = status.text ?? "";
        break;
      }
      // A service-side failure is terminal, so fail the run rather than burning
      // the remaining polls on a job that will never finish.
      if (status.status === "error") {
        throw new Error(`transcription ${jobId} failed: ${status.error ?? "unknown error"}`);
      }
      // Durable: nothing is held open across this, and the run may resume on a
      // different sandbox.
      await ctx.sleep(POLL_INTERVAL_MS);
    }

    if (transcript === undefined) {
      throw new Error(
        `transcription ${jobId} did not finish within ${(MAX_POLLS * POLL_INTERVAL_MS) / 60_000} minutes`,
      );
    }

    const summary = await ctx.step("summarize", async () => {
      const { text } = await ctx.generate({
        system: "You summarize call recordings for a busy operations team.",
        prompt: `Summarize this transcript in four sentences, then list any action items.\n\n${transcript}`,
      });
      return text;
    });

    await ctx.step("save", async () => {
      await ctx.db.query(CREATE_TABLE);
      // `on conflict (job_id)` makes the write itself idempotent, which is the
      // cheap half of at-least-once: replaying this step cannot double-insert.
      await ctx.db.query(
        `insert into transcripts (job_id, label, audio_url, summary, transcript)
         values ($1, $2, $3, $4, $5)
         on conflict (job_id) do update set summary = excluded.summary`,
        [jobId, label, audioUrl, summary, transcript],
      );
      return { saved: jobId };
    });

    return { jobId, label, words: transcript.split(/\s+/).filter(Boolean).length };
  },
});

export default agent({
  name: "Transcription Desk",
  voice: "vera",
  greeting: "Transcription desk. Give me a recording link and I'll get it processed.",
  systemPrompt: [
    "You run a transcription desk. Callers give you links to recordings.",
    "When a caller gives you a URL, call submit_recording and read back the job id",
    "in short groups of characters so they can write it down. Tell them it is",
    "processing and that they can hang up — never offer to wait on the line.",
    "If they ask about a job, call check_job with the id.",
    "If they ask what is already done, call list_transcripts.",
    "Keep replies to one or two sentences; this is a phone call.",
  ].join(" "),

  // The workflow reads this key directly, so declare it: the deploy checks that
  // every listed name is present, which turns a missing key into a deploy-time
  // error rather than a run that fails on its first step.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],

  workflows: { transcribe },

  tools: {
    submit_recording: tool({
      description: "Start transcribing a recording. Returns a run id; does not wait.",
      inputSchema: z.object({
        audioUrl: z.string().describe("URL of the recording"),
        label: z.string().optional().describe("What the caller calls this recording"),
      }),
      // Resolves as soon as the run is journaled — the transcription itself
      // continues long after this turn, and after the call.
      execute: async ({ audioUrl, label }, ctx) => {
        const runId = await ctx.workflows.start("transcribe", {
          audioUrl,
          ...(label === undefined ? {} : { label }),
        });
        return { runId, status: "processing" };
      },
    }),

    check_job: tool({
      description: "Check on a transcription that is already running.",
      inputSchema: z.object({ runId: z.string().describe("Run id from submit_recording") }),
      execute: async ({ runId }, ctx) => {
        const run = await ctx.workflows.get(runId);
        if (!run) return { error: `No job with id ${runId}` };
        if (run.status === "completed") return { status: "done", result: run.output };
        if (run.status === "failed") return { status: "failed", reason: run.error };
        // `stepsCompleted` counts polls too, so it rises while the job waits —
        // enough to say "still going" honestly without inventing a percentage.
        return { status: run.status, stepsCompleted: run.stepsCompleted };
      },
    }),

    list_transcripts: tool({
      description: "List recordings that have finished processing.",
      execute: async (_args, ctx) => {
        await ctx.db.query(CREATE_TABLE);
        const rows = await ctx.db.query<z.infer<typeof TranscriptRow>>(
          "select job_id, label, summary from transcripts order by created_at desc limit 5",
        );
        return rows.length > 0 ? { transcripts: rows } : { message: "Nothing processed yet." };
      },
    }),
  },
});
