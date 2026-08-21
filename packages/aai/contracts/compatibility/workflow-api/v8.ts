// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow-api` epoch 8.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * Epoch 8 removes nothing and adds the shape a caller OUTSIDE the agent was
 * missing: `createAgentClient`, one client for the whole of one agent — the
 * front door (`config()`) as well as every workflow route — plus the two
 * read-until-it-ends iterators (`follow`, `followOutput`) and the SSE reader
 * under them (`readEventStream`).
 *
 * What is worth freezing is the two protocol rules the iterators own, because a
 * caller who hand-rolls the loop gets both wrong and neither failure looks like
 * a bug: the state stream hands the client back with an `idle` frame after its
 * own duration cap (so a run that sleeps for hours needs a re-open, not an
 * ending), and one output read is bounded by the tail it saw (so a live run's
 * next read has to resume from an absolute index). Ending the iteration on
 * either is a run reported as finished when it is still going.
 */

import {
  type AgentClient,
  type ClientConfigResponse,
  createAgentClient,
} from "../../../sdk/agent-client.ts";
import { readEventStream } from "../../../sdk/event-stream.ts";

/** One client for the agent, built once — a fresh one per call is a fresh `fetch` closure. */
const agent: AgentClient = createAgentClient({
  baseUrl: "https://agent.example/",
  // Explicitly `| undefined`, which is what an env read gives you.
  token: process.env.AAI_WORKFLOW_API_TOKEN,
});

/** What the agent IS — the read that works whatever shape it is. */
export async function shape(): Promise<"voice" | "static"> {
  const config: ClientConfigResponse = await agent.config();
  // Absent has always read as voice, which is what every agent built before the
  // field answers.
  return config.page ?? "voice";
}

/** Start a run and report every status it passes through, ending on the terminal one. */
export async function statuses(workflow: string, input: unknown): Promise<string[]> {
  const runId = await agent.start(workflow, input);
  const seen: string[] = [];
  for await (const run of agent.follow(runId)) seen.push(run.status);
  return seen;
}

/** Everything a run wrote, in order — a replay for a reader that arrives late. */
export async function transcript(runId: string): Promise<string[]> {
  const lines: string[] = [];
  for await (const chunk of agent.followOutput(runId, { fromIndex: 0 })) {
    lines.push(String(chunk));
  }
  return lines;
}

/**
 * The raw stream, for a caller that has its own fallback to decide about.
 *
 * `watch` resolves the `Response` rather than frames precisely so this is
 * possible: a 404 from an agent deployed before the route existed is a normal
 * path, and only the caller knows what to do instead.
 */
export async function firstFrameName(runId: string): Promise<string | undefined> {
  const res = await agent.watch(runId);
  if (!(res.ok && res.body)) return undefined;
  for await (const frame of readEventStream(res.body)) return frame.event;
  return undefined;
}
