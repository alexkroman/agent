// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-2 TEMPLATE for the `aai-runtime:session` capability — reading a
 * session's retained record back from your OWN route, as it is written at epoch
 * 2. Copy the file into your host, edit the lines marked `←`, and leave the rest
 * alone.
 *
 * FROZEN. It must keep compiling for as long as epoch 2 is supported, so do not
 * edit it to follow a change in this package's API: a compile error here is the
 * finding, not a chore. Changing the API means a NEW epoch with a new template
 * beside this one — never an edit to this file.
 *
 * **`v1.ts` beside this file is still the starter for the SOCKET adapter** — one
 * session bridged to one carrier or gateway — and still compiles. What epoch 2
 * adds is one name, {@link SESSION_EVENTS_TOKEN_ENV}, and with it the thing epoch
 * 1 could not express: the bearer that closes a read surface over the retained
 * stream. It reached no published subpath at all before, so a host exposing that
 * record either hardcoded the variable's name — a second spelling of a security
 * gate, which is how one of the two comes to be misspelled — or left the
 * built-in route as it found it, which for an unset variable means OFF.
 *
 * Front to back:
 *
 * 1. Read the bearer out of the AGENT's env, once, at boot.
 * 2. Refuse a request that does not carry it — including when it is unset, which
 *    means the operator never opened this surface.
 * 3. Answer a page of the session's own events, by index.
 *
 * Nothing runs on import: call {@link createEventReadRoute} where you build your
 * admin surface, and {@link readSessionPage} from whatever serves it.
 */

import type { SessionEventPage, SessionEventStream } from "../../../runtime-barrel.ts";
import { SESSION_EVENTS_TOKEN_ENV } from "../../../runtime-barrel.ts";

/** ← how many events one page of your own route answers with. */
const PAGE_SIZE = 200;

/** What a request to this surface is answered with. */
export type EventReadResult =
  | { readonly status: 200; readonly page: SessionEventPage }
  | { readonly status: 401 | 404; readonly error: string };

/**
 * The bearer this surface requires, out of the agent's env.
 *
 * The AGENT's env, not the host's `process.env`: the same record the server reads
 * it from, so a deployment cannot end up with the built-in route closed and yours
 * open (or the reverse) because two callers looked in two places.
 *
 * `undefined` is a decision, not a missing value — see {@link createEventReadRoute}.
 */
export function eventReadToken(env: Record<string, string>): string | undefined {
  const token = env[SESSION_EVENTS_TOKEN_ENV]?.trim();
  return token === undefined || token === "" ? undefined : token;
}

/**
 * One page of a session's retained record, or the refusal.
 *
 * **Unset means OFF, and answers 404 rather than 401.** "This agent does not serve
 * that" is the true statement for a surface nobody enabled, and a 401 would
 * advertise one — which is the posture the built-in route takes, and the opposite
 * of the workflow API's deliberate fail-OPEN default. The two differ because what
 * they expose differs: a workflow app's page carries no credential and has to
 * reach its own runs, where this is a transcript.
 *
 * A session id is an unguessable UUID, which is what makes it safe to key a read
 * on — but it is not authorization on its own. Two tenants' sessions live behind
 * one agent, so the bearer is what stops a caller holding one id from walking the
 * space.
 */
export async function readSessionPage(
  stream: SessionEventStream,
  env: Record<string, string>,
  authorization: string | undefined,
  sessionId: string,
  from = 0,
): Promise<EventReadResult> {
  const token = eventReadToken(env);
  if (token === undefined) {
    return { status: 404, error: `set ${SESSION_EVENTS_TOKEN_ENV} to serve this` };
  }
  if (authorization !== `Bearer ${token}`) {
    return { status: 401, error: "Missing or invalid session events token" };
  }
  // Hydrate first: a session that belongs to a REPLACEMENT process has its record
  // in the backend and nothing in this one's cache, and a read that skipped this
  // would answer an empty page for a call that really happened.
  await stream.hydrate(sessionId);
  return { status: 200, page: await stream.read(sessionId, from, PAGE_SIZE) };
}

/** A route over {@link readSessionPage}, bound to your stream and env. ← mount this */
export function createEventReadRoute(
  stream: SessionEventStream,
  env: Record<string, string>,
): (
  authorization: string | undefined,
  sessionId: string,
  from?: number,
) => Promise<EventReadResult> {
  return (authorization, sessionId, from) =>
    readSessionPage(stream, env, authorization, sessionId, from);
}

/**
 * Whether this deployment can answer for a call that has ENDED.
 *
 * Worth reporting at boot beside the surface itself: a non-durable stream keeps a
 * session's record only as long as the process, so this route answers fully for a
 * live call and thinly for last week's — which reads as data loss to whoever asks,
 * and is a database that was never enabled.
 */
export function retainsPastSessions(stream: SessionEventStream): boolean {
  return stream.durable;
}
