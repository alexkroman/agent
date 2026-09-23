/**
 * A hold-to-talk page. Three things arrive from the agent and one goes back.
 *
 * The notebook is STATE: the agent owns it in a `sessionSlot`, `syncState`
 * projects it, `useAgentState(notebookProjection)` reads it — so a reload
 * resumes with every note on the page.
 *
 * The conversation is the stock `<MessageList>`, and the Start / Pause / End
 * row is the stock `<SessionControls>`.
 *
 * What goes BACK is the button. `usePushToTalk()` is the whole contract: spread
 * `buttonProps` onto any `<button>` and it sends the three push-to-talk
 * commands an agent declaring `turnDetection: "manual"` listens for — open a
 * turn on press (which also stops the agent if it is talking), answer it on
 * release, throw it away if the press is cancelled. It also holds the four
 * cases a hand-written `onMouseDown`/`onMouseUp` pair gets wrong, each of
 * which would leave the microphone open on a turn nothing answers: a release
 * off the button, a held key's auto-repeat, the window losing focus mid-hold,
 * and the page unmounting mid-hold. The space bar works page-wide by default.
 */

import "@alexkroman1/aai-ui/styles.css";
import {
  MessageList,
  mountClient,
  SessionControls,
  SessionErrorBanner,
  useAgentState,
  usePushToTalk,
  useSessionControls,
  useUserTranscript,
} from "@alexkroman1/aai-ui";
import { notebookProjection } from "./shared.ts";

function TalkButton() {
  const { talking, ready, buttonProps } = usePushToTalk();
  // What the caller is saying RIGHT NOW. Under push-to-talk the runtime
  // captions the whole held turn — every pause included — so this reads back
  // the note as it is being dictated, not just its last phrase.
  const { speaking, text } = useUserTranscript();

  return (
    <div className="flex flex-col items-center gap-3 px-4 py-5 border-t border-aai-border">
      <button
        type="button"
        {...buttonProps}
        className={`w-28 h-28 rounded-full text-sm font-semibold select-none touch-none transition-transform ${
          talking
            ? "scale-95 bg-aai-primary text-aai-bg"
            : "bg-aai-surface text-aai-text border border-aai-border"
        } disabled:opacity-40`}
      >
        {talking ? "Listening…" : "Hold to talk"}
      </button>
      <p className="text-xs opacity-60 text-center min-h-4">
        {!ready
          ? "Press Start to begin."
          : talking
            ? speaking
              ? text
              : "Go ahead — pause as long as you like."
            : "Hold the button or the space bar. Let go to send."}
      </p>
    </div>
  );
}

function Notebook() {
  const { notes } = useAgentState(notebookProjection);
  return (
    <div className="flex flex-col h-full text-sm bg-aai-bg text-aai-text">
      <div className="px-4 py-3 border-b border-aai-border shrink-0">
        <h2 className="text-xs font-bold uppercase tracking-wide opacity-60">Notebook</h2>
      </div>
      <div className="aai-scroll flex-1 overflow-y-auto px-3 py-2">
        {notes.length === 0 && (
          <p className="text-xs text-center py-8 opacity-40">Dictated notes land here.</p>
        )}
        {notes.map((note) => (
          <div
            key={note.id}
            className="mb-2 p-2.5 rounded-lg border border-aai-border bg-aai-surface"
          >
            <p className="text-[11px] font-semibold text-aai-primary mb-1">Note {note.id}</p>
            <p className="text-xs leading-relaxed">{note.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  // Only the Start/End hinge is read here, so this frame re-renders when the
  // call starts or ends and not at transcript rate.
  const { started } = useSessionControls();
  return (
    <div className="flex flex-col h-screen bg-aai-bg text-aai-text">
      <header className="px-4 py-3 border-b border-aai-border shrink-0">
        <h1 className="text-sm font-bold">&#128221; Field Notes</h1>
      </header>
      <MessageList className="flex-1 min-h-0" />
      <SessionErrorBanner />
      {started && <TalkButton />}
      <SessionControls className="px-4 py-3 border-t border-aai-border" />
    </div>
  );
}

mountClient({
  component: App,
  sidebar: Notebook,
  theme: {
    bg: "#101412",
    primary: "#f5b942",
    text: "#e9ece8",
    surface: "#1a201c",
    border: "#2a332d",
  },
  tools: {
    save_note: { icon: "\u{1F4DD}", label: "Saving the note" },
    list_notes: { icon: "\u{1F4D6}", label: "Reading the notebook" },
  },
});
