// Copyright 2026 the AAI authors. MIT license.
/**
 * The OTHER front door: this app driven from a script, with no browser in it.
 *
 * `client.tsx` is the page a person uses. This module is the same product for a
 * caller that is not a person — a nightly job with a list of links, a Slack bot,
 * a `curl` written down as TypeScript — and it exists because a workflow app IS
 * an HTTP API and nothing else in the templates shows one being called from
 * outside its own page. Everything here talks to a DEPLOYED agent over that API
 * (`aai dev` serves the same routes on `http://localhost:8787`), so nothing in
 * this file is bundled into the agent or into the page: it is a consumer, and it
 * ships beside the agent only so a reader can see both ends of one contract.
 *
 * ## `createAgentClient`, not `createWorkflowApiClient`
 *
 * The narrower factory is what the page uses under `useWorkflowSubmit`, and a
 * page needs nothing more: it is served BY the agent, so it already knows which
 * agent it is. A script does not. `createAgentClient` is that client plus the
 * one read that answers "what have I been pointed at" — `GET /client-config` —
 * and {@link connect} spends it once so the failure for a mistyped or
 * repurposed base URL is a sentence naming the URL, rather than a 404 from
 * `POST /workflows/runs` three calls later.
 *
 * ## The run outlives the call, here as much as in the tab
 *
 * {@link digestLink} follows a run to its end because a script usually wants the
 * answer, but `agent.start()` alone is the honest shape for a job that only
 * needs the work done — it resolves as soon as the run exists, and the digest
 * happens whether this process is alive or not. That is the same durability
 * `client.tsx`'s module doc argues about from the browser side, and
 * {@link pastDigests} is the same recovery: a correlation KEY, not a `runId`, is
 * what a caller can still hold tomorrow.
 *
 * The key is the caller's to choose and it must not be derived from the URL
 * being digested — `use-run-key.ts` in `@alexkroman1/aai-ui` argues why, and the
 * argument does not change for a script: a key is a HANDLE on "runs I asked
 * for", and two callers digesting the same link would otherwise read each
 * other's.
 */

import {
  type AgentClient,
  createAgentClient,
  type FindOptions,
  isTerminal,
  type TerminalWorkflowRun,
  type WorkflowApiClientOptions,
  type WorkflowOutputOf,
  type WorkflowRunOf,
} from "@alexkroman1/aai/workflow-api";
import { omitUndefined } from "@alexkroman1/aai/utils";
// ERASED at build time, exactly as in `client.tsx`: the def is what knows the
// output's shape, and naming it here is what stops this module restating a type
// `workflows/digest.ts` already declares.
import type { digest } from "./agent.ts";

/**
 * The workflow's NAME, which is the only thing an outside caller can address it
 * by.
 *
 * A literal rather than an import from `agent.ts`, because that is what a caller
 * in another repository would have to write — and `agent.test.ts` pins the key
 * so a rename fails there rather than at somebody's 400.
 */
const WORKFLOW = "digest";

/** A digest run at any stage, with `output` typed by the declaration. */
export type DigestRun = WorkflowRunOf<typeof digest>;

/**
 * A digest run that has STOPPED — completed, failed or cancelled.
 *
 * The return type of {@link digestLink}, and it is the point of that function:
 * a caller holding one of these never has to ask "is it still going", so the
 * `status` switch it writes has three arms rather than five.
 */
export type SettledDigest = TerminalWorkflowRun<WorkflowOutputOf<typeof digest>>;

/**
 * Point a client at a deployed Link Digest, and refuse anything that is not one.
 *
 * `config()` is the one read that works on every agent whatever shape it is, and
 * `page: "static"` is the discriminant `workflowApp()` sets — so this catches
 * the mistake a script actually makes, which is a base URL copied from the wrong
 * agent. Unauthenticated on a deployed agent, like the page it describes, so it
 * works before any `token` is involved.
 */
export async function connect(options: WorkflowApiClientOptions): Promise<AgentClient> {
  const agent = createAgentClient(options);
  const config = await agent.config();
  if (config.page !== "static") {
    // `agent.baseUrl` rather than `options.baseUrl`: the client normalizes away
    // a trailing slash, and quoting what it actually called is what makes a
    // `//workflows` typo visible.
    throw new Error(
      `${agent.baseUrl} answers as a voice agent, not a workflow app — there is no "${WORKFLOW}" to start there.`,
    );
  }
  return agent;
}

/**
 * Digest one link and wait for the run to settle.
 *
 * `follow` rather than a poll: it re-opens the stream when the route hands the
 * client back after its own duration cap, so one `for await` covers a run that
 * sleeps — which this one does, for `SETTLE_MS`. A caller that does not need the
 * answer should call `agent.start()` and walk away.
 */
export async function digestLink(
  agent: AgentClient,
  url: string,
  key?: string,
): Promise<SettledDigest> {
  const runId = await agent.start(WORKFLOW, { url }, omitUndefined({ key }));
  // The HTTP client is not generic over a declaration — it cannot be, since it
  // is written against an agent it may never have seen — so the output type is
  // asserted from the def here, which is the same claim `WorkflowClient.get`
  // makes for a caller inside the agent.
  const snapshots = agent.follow(runId) as AsyncIterable<DigestRun>;
  let latest: DigestRun | undefined;
  for await (const snapshot of snapshots) latest = snapshot;
  // `follow` ends having yielded NOTHING for an id the agent does not know, and
  // that is a stable answer rather than a timing problem: the world's record is
  // durable, so an id that does not exist never will.
  if (!isTerminal(latest)) throw new Error(`${agent.baseUrl} knows no run ${runId}.`);
  return latest;
}

/**
 * The digests this caller asked for before, newest first.
 *
 * The script's half of what `useWorkflowSubmit` does as the page mounts — a
 * `runId` is gone the moment the process exits, and the correlation key is the
 * handle that is not. Deployed, this needs the key INDEX, which is a
 * `DATABASE_URL` away; `agent.ts` says what happens without one.
 */
export function pastDigests(
  agent: AgentClient,
  key: string,
  options?: FindOptions,
): Promise<DigestRun[]> {
  return agent.find(WORKFLOW, key, options) as Promise<DigestRun[]>;
}
