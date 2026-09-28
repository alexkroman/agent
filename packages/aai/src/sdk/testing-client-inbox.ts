// Copyright 2026 the AAI authors. MIT license.
/**
 * `stubClientInbox()` — a device on the other end of `stepNotifyClient`, for a
 * spec: it records every notice a step pushed and answers each one.
 *
 * Published into the same slot `createRuntimeServer` fills, so a step under test
 * takes the path production does, including the `ClientUnreachableError` it
 * throws when the answer is not an ack.
 *
 * @module
 */

import {
  type ClientNotice,
  type ClientUnreachableReason,
  publishClientNotifier,
} from "./step-notify-client.ts";

/** One pushed notice, as {@link stubClientInbox} records it. */
export type StubClientInboxCall = { clientId: string; notice: ClientNotice };

/** What {@link stubClientInbox} may be told. */
export type StubClientInboxOptions = {
  /**
   * How the device answers each notice: `"acked"` (the default), or a reason it
   * did not take it — `"offline"`, `"busy"`, `"no-ack"`, `"disconnected"`. A
   * function answers per call, e.g. busy once and then acked.
   */
  answer?:
    | "acked"
    | ClientUnreachableReason
    | ((call: StubClientInboxCall) => "acked" | ClientUnreachableReason)
    | undefined;
};

/** What {@link stubClientInbox} returns: the call log, and how to put the slot back. */
export type StubClientInbox = {
  /** Every notice pushed, in order — including those the device did not take. */
  calls: StubClientInboxCall[];
  /** Unpublish the inbox. Call it in an `afterEach`, like `stubSpeech`'s. */
  restore(): void;
};

/**
 * Publish an inbox whose device records every notice and answers it.
 *
 * @public
 */
export function stubClientInbox(options: StubClientInboxOptions = {}): StubClientInbox {
  const calls: StubClientInboxCall[] = [];
  publishClientNotifier((clientId, notice) => {
    const call = { clientId, notice };
    calls.push(call);
    const { answer = "acked" } = options;
    return Promise.resolve(typeof answer === "function" ? answer(call) : answer);
  });
  return { calls, restore: () => publishClientNotifier(undefined) };
}
