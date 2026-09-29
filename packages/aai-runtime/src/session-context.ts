// Copyright 2026 the AAI authors. MIT license.
/**
 * Running an agent's `sessionContext` hook: once, bounded, and never fatal.
 *
 * The hook is the app's — a database read, a memory service, maybe a model
 * call — and it runs inside `session.start()`, which is the window between
 * the client's handshake and the session being ready, with the caller's first
 * words buffered behind it. So three rules, each the answer to a way the hook
 * could otherwise break the call it is meant to improve:
 *
 * - **A hard deadline** ({@link SESSION_CONTEXT_TIMEOUT_MS}). A speaker that
 *   takes four seconds to answer "what time is it" because a profile service is
 *   slow is worse than one that answers without the profile. The hook gets an
 *   `AbortSignal` that fires at the deadline, and an answer after it is dropped.
 * - **Failure is a log line.** A throw, a rejection or a timeout is `warn`ed
 *   and the session starts without context. The start's own deadline
 *   (`DEFAULT_SESSION_START_TIMEOUT_MS`, 10 s) is what a failure HERE would
 *   otherwise spend, and it ends in a fatal 1011 the client reads as "Session
 *   failed to start".
 * - **The answer is checked.** It crosses from author code, so a non-string
 *   `instructions` or a non-finite `historySince` is dropped with a warning
 *   rather than concatenated into a prompt or compared against a timestamp,
 *   and a `location` is held to the rule the socket's `?location=` is.
 *
 * Its own module rather than a closure in `runtime-session-memory.ts` so the
 * three rules are testable without a session around them.
 */

import type { AgentDef, SessionContext, SessionContextArgs } from "@alexkroman1/aai";
import { normalizeClientLocation } from "@alexkroman1/aai/host-internal";
import { errorMessage, isRecord } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";

/**
 * How long a session waits for its `sessionContext` before starting without it.
 *
 * 1.5 s: long enough for one indexed read against a remote database or a small
 * model call, and short enough to sit inside the gap a voice client already
 * spends opening its microphone after `session.configured` — the start window
 * this runs in is not otherwise on the caller's critical path until they speak.
 */
export const SESSION_CONTEXT_TIMEOUT_MS = 1500;

/** What the deadline resolves with — a symbol, so no author answer can equal it. */
const TIMED_OUT: unique symbol = Symbol("sessionContext timed out");

/** A validated answer, or `undefined` for none. */
function checked(value: unknown, log: Logger, sid: string): SessionContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    log.warn("sessionContext answered something that is not an object; ignored", { sid });
    return undefined;
  }
  const out: SessionContext = {};
  const { instructions, historySince } = value;
  if (typeof instructions === "string") out.instructions = instructions;
  else if (instructions !== undefined) {
    log.warn("sessionContext `instructions` is not a string; ignored", { sid });
  }
  if (typeof historySince === "number" && Number.isFinite(historySince)) {
    out.historySince = historySince;
  } else if (historySince !== undefined) {
    log.warn("sessionContext `historySince` is not a finite number; ignored", { sid });
  }
  // The socket's rule, so the app cannot put into the slot what `?location=`
  // would have refused. The warning names the field and never the value: it is
  // an address.
  const { location } = value;
  const place = typeof location === "string" ? normalizeClientLocation(location) : undefined;
  if (place !== undefined) out.location = place;
  else if (location !== undefined) {
    log.warn("sessionContext `location` is not a usable string; ignored", { sid });
  }
  return out;
}

/**
 * Ask `hook` for this session's context, within `timeoutMs`.
 *
 * Resolves `undefined` when there is no hook, or when it failed, timed out or
 * answered nothing — never rejects.
 *
 * @internal
 */
export async function resolveSessionContext(options: {
  hook: AgentDef["sessionContext"];
  args: Omit<SessionContextArgs, "signal">;
  logger: Logger;
  timeoutMs?: number | undefined;
}): Promise<SessionContext | undefined> {
  const { hook, args, logger } = options;
  if (!hook) return undefined;
  const sid = args.sessionId.slice(0, 8);
  const timeoutMs = options.timeoutMs ?? SESSION_CONTEXT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`sessionContext timed out after ${timeoutMs}ms`));
      resolve(TIMED_OUT);
    }, timeoutMs);
  });
  try {
    // `async` wrapper so a SYNCHRONOUS throw lands in the same catch as a
    // rejection, and a plain-value answer is awaited like a promise.
    const answer = await Promise.race([
      (async () => await hook({ ...args, signal: controller.signal }))(),
      deadline,
    ]);
    if (answer === TIMED_OUT) {
      logger.warn("sessionContext timed out; session starting without it", { sid, timeoutMs });
      return undefined;
    }
    return checked(answer, logger, sid);
  } catch (err: unknown) {
    logger.warn("sessionContext failed; session starting without it", {
      sid,
      error: errorMessage(err),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
