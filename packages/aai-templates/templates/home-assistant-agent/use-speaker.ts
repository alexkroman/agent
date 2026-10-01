import {
  type InboxNotice,
  useConversationLog,
  useEvent,
  useInbox,
  useSession,
  useTapToTalk,
} from "@alexkroman1/aai-ui";
import { useCallback, useEffect } from "react";

// A smart speaker, on top of the SDK's browser session:
//
//   IDLE --tap/type--> CONNECTING --connected--> ACTIVE --tap, or quiet for FOLLOWUP_MS--> IDLE
//
// No wake word: one tap (the ring or the space bar) goes LIVE, a realtime conversation
// with the mic open, and the next tap hangs up. That, the muted mic for a typed turn, the
// follow-up window and the connect timeout are aai-ui's useTapToTalk. Hanging up is
// disconnect(), not end(), so the next turn RESUMES the same session.

/** How long the speaker stays live after it last spoke, waiting for a follow-up. */
const FOLLOWUP_MS = 3000;
const CONNECT_TIMEOUT_MS = 8000;
const THINKING_TIMEOUT_MS = 60_000;

/** The ring's states. */
export type Led = "off" | "connecting" | "listening" | "thinking" | "speaking" | "error";

export function useSpeaker() {
  const session = useSession();
  const tap = useTapToTalk({
    idleHangupMs: FOLLOWUP_MS,
    thinkingHangupMs: THINKING_TIMEOUT_MS,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  });
  // Everything said and heard, across sessions, kept in this browser.
  const log = useConversationLog({ storageKey: "home-assistant:log", max: 300 });
  const { addNote, addSpoken } = log;

  // The inbox: held open from load, busy while a session runs, so a reminder or a
  // finished research job never talks over a reply. It plays each notice itself.
  const inbox = useInbox({
    // What the speaker said out loud is its turn, word for word: shown as its bubble.
    onNotice: (n) => {
      const said = n.data?.said;
      if (typeof said === "string" && said.trim()) addSpoken(said);
      else addNote(noticeText(n));
    },
  });
  const stopCues = inbox.stopPlayback;

  // Going live cuts off a notice that is playing.
  useEffect(() => {
    if (tap.live) stopCues();
  }, [tap.live, stopCues]);

  // tools/stop.ts: the model is still writing its follow-up to the stop call, so cancel
  // it and hang up, and nothing it says after has anywhere to play.
  useEvent("stop", () => {
    stopCues();
    session.cancel();
    tap.hangUp();
  });

  /**
   * Start over: a fresh session, so the next turn begins a new conversation rather than
   * resuming this one. Reminders and research already started are runs, and still land.
   */
  const restart = useCallback(() => {
    stopCues();
    tap.hangUp();
    session.restart();
    addNote("New conversation");
  }, [session, tap, addNote, stopCues]);

  const led: Led =
    tap.phase === "connecting"
      ? "connecting"
      : tap.phase === "idle"
        ? tap.failed
          ? "error"
          : "off"
        : session.state === "speaking"
          ? "speaking"
          : session.state === "thinking"
            ? "thinking"
            : tap.live
              ? "listening"
              : "off";

  return { led, tap, restart, history: log.entries, inboxUp: inbox.connected };
}

/** The history line for a notice that carries no `said`. */
function noticeText(n: InboxNotice): string {
  const text = n.data?.text ?? n.data?.topic;
  const what = typeof text === "string" ? `: ${text}` : "";
  return `${n.event.charAt(0).toUpperCase()}${n.event.slice(1)}${what}`;
}
