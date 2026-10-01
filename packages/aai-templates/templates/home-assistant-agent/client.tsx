/// <reference types="vite/client" />
import "@alexkroman1/aai-ui/styles.css";
import {
  ConversationView,
  mountClient,
  SessionErrorBanner,
  ToolCallRow,
} from "@alexkroman1/aai-ui";
import { type SubmitEvent, useState } from "react";
import { Ring } from "./ring.tsx";
import { type Led, useSpeaker } from "./use-speaker.ts";

// The speaker, on a page: its ring as a button that starts and ends a live conversation
// on one side, and on the other everything said to it, plus a box to type to it.

const STATUS: Record<Led, string> = {
  off: "Tap the ring or press space to talk, or type",
  connecting: "Connecting…",
  listening: "Listening: tap again to hang up",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Couldn’t reach the agent",
};

function App() {
  const speaker = useSpeaker();
  const { live, buttonProps } = speaker.tap;

  return (
    <main className="flex flex-col md:flex-row h-screen bg-aai-bg text-aai-text">
      <section className="flex flex-col items-center justify-center gap-6 p-6 md:w-96 shrink-0 border-b md:border-b-0 md:border-r border-aai-border">
        {/* One tap goes live, mic open for a realtime conversation; the next hangs up. */}
        <button
          type="button"
          {...buttonProps}
          className={`relative grid place-items-center rounded-full bg-aai-surface border border-aai-border cursor-pointer select-none transition-transform focus-visible:outline-2 focus-visible:outline-aai-primary ${
            live ? "scale-95" : ""
          }`}
        >
          <Ring led={speaker.led} />
          <span className="absolute text-sm font-semibold tracking-wide opacity-70">
            {live ? "Tap to hang up" : "Tap to talk"}
          </span>
        </button>
        <p className="text-sm text-center text-balance min-h-10 leading-relaxed" aria-live="polite">
          {STATUS[speaker.led]}
        </p>
        <p className="text-xs opacity-60" title="Reminders and research results are said here">
          Inbox {speaker.inboxUp ? "connected" : "offline"}
        </p>
      </section>

      <section className="flex flex-col flex-1 min-h-0">
        <header className="flex items-center justify-between px-4 py-3 border-b border-aai-border">
          <h1 className="text-sm font-bold">Home Assistant</h1>
          <button
            type="button"
            className="text-xs opacity-60 hover:opacity-100"
            title="Start a fresh conversation; reminders already set still go off"
            onClick={speaker.restart}
          >
            New conversation
          </button>
        </header>
        <ConversationView
          log={speaker.history}
          className="flex-1 min-h-0"
          scrollClassName="aai-scroll overflow-y-auto"
          contentClassName="px-4 py-4 flex flex-col gap-3"
          empty={
            <p className="text-sm text-center opacity-40 py-12">
              Nothing said yet. Tap to talk, or type below.
            </p>
          }
          renderMessage={(m) => <Bubble from={m.role} text={m.content} />}
          renderStreaming={(text) => <Bubble from="assistant" text={text} live />}
          renderTranscript={({ text }) => text && <Bubble from="user" text={text} live />}
          renderTool={(t) => (
            <ToolCallRow
              title={t.name}
              detail={Object.keys(t.args).length > 0 ? JSON.stringify(t.args) : undefined}
              pending={t.status === "pending"}
              variant="compact"
              className="self-start max-w-full"
            />
          )}
          renderNote={(n) => (
            <p className="text-xs text-center opacity-50">
              {clock(n.at)} · {n.text}
            </p>
          )}
          renderSessionHeader={(entry) => (
            <p className="text-xs text-center opacity-40">{clock(entry.at)}</p>
          )}
          thinkingLabel="The speaker is thinking"
          thinkingClassName="self-start text-sm opacity-50 px-3"
        />
        <SessionErrorBanner className="mx-3 mb-2" />
        <Composer onSend={speaker.tap.send} />
      </section>
    </main>
  );
}

function Bubble({
  from,
  text,
  live,
}: {
  from: "user" | "assistant";
  text: string;
  live?: boolean;
}) {
  const mine = from === "user";
  return (
    <p
      className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
        mine
          ? "self-end bg-aai-primary text-aai-bg"
          : "self-start bg-aai-surface border border-aai-border"
      } ${live ? "opacity-60" : ""}`}
    >
      {text}
    </p>
  );
}

function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    onSend(text);
    setText("");
  };
  return (
    <form onSubmit={submit} className="flex gap-2 p-3 border-t border-aai-border">
      <label htmlFor="say" className="sr-only">
        Type to the speaker
      </label>
      <input
        id="say"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type instead of talking…"
        autoComplete="off"
        className="flex-1 px-3 py-2 rounded-lg bg-aai-surface border border-aai-border text-sm outline-none focus:border-aai-primary"
      />
      <button
        type="submit"
        disabled={!text.trim()}
        className="px-4 py-2 rounded-lg bg-aai-primary text-aai-bg text-sm font-semibold disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

mountClient({
  component: App,
  name: "Home Assistant",
  // This browser's own ?client= id: what lets a reminder or a finished research job find
  // this page again after the session ends (useInbox holds the socket it arrives on).
  client: "auto",
  theme: {
    bg: "#0c0c0e",
    primary: "#6d8bff",
    text: "#e7e7ea",
    surface: "#18181b",
    border: "#2a2a30",
  },
});
