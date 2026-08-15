// Copyright 2026 the AAI authors. MIT license.
/**
 * What a note posted into the conversation is, and how it should get there.
 *
 * Its own module for the same reason `chat-queue.ts` is: the decision is a pure
 * function of two booleans, it is the thing that was WRONG (see
 * use-notify-registration.ts for the transcript corruption), and a pure
 * function is the half a test can pin without a live `useChat`.
 */

/**
 * Post a message into the live conversation.
 *
 * Default is a silent append: the message shows in the transcript and rides
 * along with the agent's *next* turn, which is what a successful publish or a
 * secret change wants — neither needs an answer, and spending a turn on
 * "published fine" invites the agent to go do unrequested work.
 *
 * `respond: true` sends it as a real turn instead. A FAILED publish needs
 * that: the CLI output is only useful if the agent actually engages with it,
 * and as a silent note it would sit there until the user typed something,
 * which reads as the agent ignoring a build break it was told about.
 */
export type NotifyChat = (text: string, opts?: { respond?: boolean }) => void;

/** Where a note goes: its own turn, straight into the transcript, or a wait. */
export type NotifyMode = "turn" | "append" | "defer";

/**
 * How a notification should reach the conversation.
 *
 * A busy chat DEFERS. It used to fall back to `"append"` — chosen as the safe
 * option, on the reasoning that a publish failure has to survive either way and
 * an appended message still rides the next turn. But appending underneath a
 * STREAMING message is what corrupts the transcript (the SDK's writer pushes
 * the streaming message a second time rather than replacing it, leaving one
 * object at two indices under one React key, and that array is what gets
 * persisted). Nothing is dropped by waiting: the note is held outside
 * `messages` and delivered on the settle, which is the same thing the
 * follow-up queue does with a message typed mid-turn.
 */
export function notifyDispatch(
  opts: { respond?: boolean } | undefined,
  state: { busy: boolean; chatReady: boolean },
): NotifyMode {
  if (state.busy) return "defer";
  return opts?.respond === true && state.chatReady ? "turn" : "append";
}
