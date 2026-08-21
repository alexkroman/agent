// Copyright 2026 the AAI authors. MIT license.
/**
 * A SCHEDULED workflow app — a run that repeats on an interval and outlives
 * everything, including the tab that started it.
 *
 * Its front door is a form, not a microphone: no session, no WebSocket, no
 * voice pipeline. `client.tsx` starts a run over the workflow HTTP API and
 * watches it, and `workflows/digest.ts` does the work.
 *
 * ## What makes this a different KIND of workflow app from `link-digest`
 *
 * `link-digest` is the smallest one: one URL in, one digest out, run over. This
 * is the same front door around a run that **sleeps for days and wakes up
 * again**. Three consequences worth reading before copying it:
 *
 * - **The run is the schedule.** There is no cron anywhere in this template.
 *   `sleep()` inside a durable body IS the scheduler — the run suspends,
 *   nothing is resident, and the platform brings it back. That is the cheapest
 *   recurring job you can write here and it needs no infrastructure.
 * - **It is asked when to stop.** `daysToRun` is an input rather than a
 *   constant because a run with no end is a resource nobody can see. It posts
 *   what it owes and finishes.
 * - **Storage stops being optional.** A multi-day sleep does not survive in
 *   process memory. See `workflows/digest.ts` for what that looks like when you
 *   forget (the first digest arrives; the second never does).
 *
 * ## What it needs
 *
 * `ASSEMBLYAI_API_KEY` in the agent env — `.env` under `aai dev`, `aai secret
 * put ASSEMBLYAI_API_KEY` once deployed — because the run really transcribes
 * the episodes and really summarizes them. `requiredEnv` is what makes a deploy
 * check for it rather than letting the first run find out, and it is
 * load-bearing here in a way it is not for a voice agent: a workflow app
 * declares no providers, so nothing else in its config names a credential.
 *
 * A step is handed no `ToolContext`, so it reads that key with `requireStepEnv`
 * rather than `ctx.env` — which the SDK's transcription and model helpers do
 * for you, and which is why nothing in `workflows/` mentions the key by name.
 *
 * The Slack webhook is the other credential and is deliberately NOT env: it is
 * per-run input, so one deployed agent can post to whichever channel each run
 * names.
 */

import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { dailyDigestFlow } from "./workflows/digest.ts";
import { isSlackWebhookUrl } from "./workflows/slack.ts";

/** Somebody pastes a list; anything not http(s) is a typo worth catching here. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The declaration: schema, description, and the body.
 *
 * The `input` schema does double duty in a way it cannot for a voice agent. It
 * validates at `start()` — so a bad feed URL or a non-Slack webhook is a 400 at
 * the call site rather than a failed run discovered an hour later, after
 * transcription has already been paid for — and it is served on
 * `GET /workflows` as JSON Schema, which is what lets a page render a form for
 * a workflow it was not written against.
 *
 * Every field carries `.describe()` for that second reason, and every optional
 * one carries `.default()` so the page and the body agree on the fallback
 * instead of each picking its own.
 */
export const dailyDigest = workflow({
  description:
    "Watch podcast feeds, transcribe new episodes with AssemblyAI, summarize them, " +
    "and post a digest to Slack on a repeating schedule",
  input: z.object({
    podcastChannels: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => value.split(",").every((url) => isHttpUrl(url.trim())),
        "Enter comma-separated podcast links",
      )
      .describe("Podcast links — Apple Podcasts, Spotify, RSS, or a show page — comma-separated"),
    // A host check, not a URL check. This value is the target of a POST
    // carrying summarized content, so "is it a URL" would accept an
    // exfiltration endpoint somebody typed into a form.
    slackWebhookUrl: z
      .string()
      .trim()
      .url()
      .refine(isSlackWebhookUrl, "Enter a Slack webhook URL from hooks.slack.com")
      .describe("Slack incoming webhook or workflow trigger URL"),
    slackWorkflowTextParam: z
      .string()
      .trim()
      // A Slack workflow variable name. Constrained because it is used as an
      // object KEY in the request body, and an arbitrary string there is a way
      // to shape a payload the workflow never declared.
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .default("text")
      .describe("Slack workflow variable name (workflow trigger URLs only)"),
    maxEpisodesPerDigest: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Most episodes to include in one digest"),
    intervalEvery: z.number().int().min(1).max(365).default(1).describe("Repeat every"),
    intervalUnit: z
      .enum(["minutes", "hours", "days"])
      .default("days")
      .describe("Unit for the repeat interval"),
    // Bounded on purpose — see the module doc on why a run is asked to end.
    daysToRun: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(7)
      .describe("How many digests to post before the run completes"),
  }),
  run: dailyDigestFlow,
});

export default workflowApp({
  name: "Podcast Digest",
  // The whole product. A workflow app is an agent whose work happens here.
  workflows: { dailyDigest },
  // Checked at deploy time. A workflow app declares no providers, so this is
  // the only thing that can name the credential its steps read.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
