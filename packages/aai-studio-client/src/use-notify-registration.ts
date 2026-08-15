// Copyright 2026 the AAI authors. MIT license.
/**
 * How publish output and secret changes reach the coding agent — and why one
 * of the three ways it could do that was corrupting the transcript.
 *
 * A note is either sent as a real turn, appended silently to ride along with
 * the agent's next turn, or — the case this module exists for — DEFERRED until
 * the current turn settles.
 *
 * **Appending mid-turn corrupts the conversation.** The AI SDK's streaming
 * writer (`ai@7`, `Chat.makeRequest`) compares `response.state.message.id`
 * against `this.lastMessage?.id` on every chunk and takes `pushMessage` when
 * they differ. A note appended underneath a streaming assistant message BECOMES
 * `lastMessage`, so the next chunk pushes the assistant message a second time
 * instead of replacing it in place: the same object then sits at two indices
 * with the same `id`, which is the React key — and that array is what the
 * end-of-turn sync PERSISTS as the project's conversation. Saving a secret,
 * toggling the Database card, or a Publish resolving while the agent is working
 * is enough to trigger it.
 *
 * So `"append"` — chosen precisely as the *safe* fallback for the busy case —
 * was the one mode that is not safe there. Deferring is: the note is held
 * outside `messages` (exactly as the follow-up queue is, and for the same
 * reason) and delivered when the agent next owes no work.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { NotifyChat } from "./chat-notify.ts";
import { notifyDispatch } from "./chat-notify.ts";

/** A note waiting for the turn in flight to settle. */
type DeferredNote = { readonly text: string; readonly opts: { respond?: boolean } | undefined };

export type NotifyRegistrationOptions = {
  /** Hands the app the function that posts into this conversation. */
  registerNotify?: ((fn: NotifyChat | null) => void) | undefined;
  /**
   * The agent still owes work — a turn in flight OR queued follow-ups. Both
   * block a note: a turn because appending under it corrupts the transcript,
   * and a queue because a note sent as its own turn would jump the line.
   */
  pending: boolean;
  /** `/studio/status` has answered. */
  chatReady: boolean;
  sendMessage: (message: { text: string }) => unknown;
  /** Append a user message to the transcript, outside any streaming turn. */
  appendMessage: (text: string) => void;
};

export function useNotifyRegistration(opts: NotifyRegistrationOptions): void {
  const { registerNotify, pending, chatReady, sendMessage, appendMessage } = opts;

  // Read through refs so the registration below stays stable: re-registering
  // on every status tick would swap the function the app holds mid-publish.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const chatReadyRef = useRef(chatReady);
  chatReadyRef.current = chatReady;
  const sendRef = useRef(sendMessage);
  sendRef.current = sendMessage;
  const appendRef = useRef(appendMessage);
  appendRef.current = appendMessage;

  const [deferred, setDeferred] = useState<readonly DeferredNote[]>([]);

  const deliver = useCallback((note: DeferredNote, mode: "turn" | "append") => {
    if (mode === "turn") {
      void sendRef.current({ text: note.text });
      return;
    }
    appendRef.current(note.text);
  }, []);

  useEffect(() => {
    if (!registerNotify) return;
    registerNotify((text, notifyOpts) => {
      const mode = notifyDispatch(notifyOpts, {
        busy: pendingRef.current,
        chatReady: chatReadyRef.current,
      });
      if (mode === "defer") {
        setDeferred((current) => [...current, { text, opts: notifyOpts }]);
        return;
      }
      deliver({ text, opts: notifyOpts }, mode);
    });
    return () => registerNotify(null);
  }, [registerNotify, deliver]);

  // Flush on the settle, in arrival order, and AT MOST ONE as a turn: a second
  // `sendMessage` in the same window would run two turns against one guest
  // session, which is the thing chat-queue.ts exists to prevent. A later
  // `respond` note degrades to an append rather than being dropped — an
  // appended message still rides the turn the first one just started.
  //
  // Appending here is safe in a way appending mid-stream is not: the SDK pushes
  // the assistant message into `messages` only from `write()`, which sets the
  // status to `streaming` first — so while nothing is pending there is no
  // streaming message underneath to collide with.
  useEffect(() => {
    if (pending || deferred.length === 0) return;
    setDeferred([]);
    let turnTaken = false;
    for (const note of deferred) {
      // Re-decided at DELIVERY time: what was blocked as busy may now be a turn.
      const mode = notifyDispatch(note.opts, { busy: false, chatReady: chatReadyRef.current });
      if (mode === "turn" && !turnTaken) {
        turnTaken = true;
        deliver(note, "turn");
        continue;
      }
      deliver(note, "append");
    }
  }, [pending, deferred, deliver]);
}
