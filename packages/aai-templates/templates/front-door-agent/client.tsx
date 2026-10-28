import "@alexkroman1/aai-ui/styles.css";
import {
  ChatView,
  type ConversationItem,
  createLinkedClient,
  createStoredValue,
  type InboxNotice,
  inboxEventToItem,
  mountClient,
  StartScreen,
  useInbox,
  useRoute,
  useRouteMutation,
  useStoredValue,
} from "@alexkroman1/aai-ui";
import { useEffect, useState } from "react";
import type { DoorNotice, PairStarted, PairStatus } from "./shared.ts";

// One page, two ends. Which one this browser is, is remembered here: the DOOR (a tablet
// by the door: Ring, then talk) or the owner's PHONE. A phone links to a door by reading a
// code to it, and from then on it IS the door's twin: createLinkedClient answers the
// door's id, so its inbox is the door's, and it watches every conversation at the door.

/** Which end this browser is. */
const role = createStoredValue("front-door.role");

/** The door this phone is linked to, kept in this browser; unlinked, the browser's own id. */
const linked = createLinkedClient({ key: "front-door.linked" });

/** How often a phone waiting to link asks whether the door heard its code. */
const PAIR_POLL_MS = 2000;

/** Most notices and live lines a phone keeps on screen. */
const KEEP = 30;

function App() {
  const [end, setEnd] = useStoredValue(role);
  if (end === "door") return <Door onSwitch={() => setEnd(undefined)} />;
  if (end === "phone") return linked.linked() ? <Phone /> : <Pairing />;
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 bg-aai-bg p-6 text-aai-text">
      <h1 className="text-2xl font-semibold">Front Door</h1>
      <p className="text-sm opacity-70">What is this device?</p>
      <div className="flex gap-3">
        <button type="button" className={BUTTON} onClick={() => setEnd("door")}>
          The door
        </button>
        <button type="button" className={BUTTON} onClick={() => setEnd("phone")}>
          My phone
        </button>
      </div>
    </main>
  );
}

const BUTTON =
  "rounded-lg bg-aai-primary px-5 py-3 text-sm font-semibold text-aai-bg disabled:opacity-40";

/** The door: ring, then talk. The conversation is the SDK's own ChatView. */
function Door({ onSwitch }: { onSwitch: () => void }) {
  return (
    <>
      <StartScreen
        icon={<span className="text-5xl">🚪</span>}
        subtitle="Ring to talk to the house."
        buttonText="Ring the bell"
      >
        <ChatView icon="🚪" />
      </StartScreen>
      <button
        type="button"
        onClick={onSwitch}
        className="fixed bottom-2 right-3 text-xs opacity-40 hover:opacity-100"
      >
        Not the door?
      </button>
    </>
  );
}

/**
 * An unlinked phone: ask for a code (POST /api/pair, through useRouteMutation), show it,
 * and wait for the door to hear it (GET /api/pair/:runId). Linked, it stores the door's id
 * and reloads, so the session and the inbox open as the door's twin.
 */
function Pairing() {
  const { run, busy, error } = useRouteMutation();
  const [started, setStarted] = useState<PairStarted | undefined>(undefined);
  const { data: status } = useRoute<PairStatus>(
    started ? `/pair/${encodeURIComponent(started.runId)}` : null,
    { pollMs: PAIR_POLL_MS, until: (s) => s.status !== "waiting" },
  );

  const doorId = status?.status === "linked" ? status.doorId : undefined;
  useEffect(() => {
    if (doorId === undefined) return;
    linked.set(doorId);
    location.reload();
  }, [doorId]);

  const ask = async () =>
    setStarted(await run<PairStarted>("POST", "/pair", undefined, { key: "pair" }));
  return (
    <main className="mx-auto flex h-screen max-w-sm flex-col items-center justify-center gap-5 bg-aai-bg p-6 text-center text-aai-text">
      <h1 className="text-2xl font-semibold">Link this phone</h1>
      {started === undefined || status?.status === "expired" ? (
        <>
          <p className="text-sm opacity-70">
            {status?.status === "expired"
              ? "That code expired before the door heard it."
              : "You'll get a code to read out to the door."}
          </p>
          <button
            type="button"
            className={BUTTON}
            disabled={busy !== undefined}
            onClick={() => void ask()}
          >
            {busy ? "Getting a code…" : "Get a code"}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm opacity-70">Ring the door and say:</p>
          <p className="text-lg">"Link my phone, the code is"</p>
          <p className="font-mono text-4xl tracking-[0.3em]">{started.code}</p>
          <p className="text-xs opacity-60">Waiting for the door…</p>
        </>
      )}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </main>
  );
}

/** One line on the phone: what the door told it, said as a person would read it. */
function noticeLine(notice: InboxNotice): string {
  const data = notice.data as DoorNotice | undefined;
  switch (data?.kind) {
    case "visitor":
      return `${data.name}: "${data.message}"`;
    case "ring":
      return "Someone rang the bell.";
    case "digest":
      return data.summary;
    default:
      return notice.event;
  }
}

/**
 * A linked phone: the door's inbox (useInbox holds it under the door's id), with the
 * door's notices and, through `onEvent`, every conversation at the door as it happens:
 * inboxEventToItem turns each frame into a line, and drops the ones a person would not
 * read (partials, fillers, tool completions).
 */
function Phone() {
  const [notices, setNotices] = useState<{ id: string; at: number; line: string }[]>([]);
  const [live, setLive] = useState<{ key: string; item: ConversationItem }[]>([]);
  const { run, busy, error } = useRouteMutation();

  const { connected } = useInbox({
    play: false,
    onNotice: (notice) =>
      setNotices((all) =>
        [{ id: notice.id, at: Date.now(), line: noticeLine(notice) }, ...all].slice(0, KEEP),
      ),
    onEvent: (event) =>
      setLive((all) => {
        const item = inboxEventToItem(event, all.length);
        if (item === undefined || event.type !== "session_event") return all;
        return [...all, { key: `${event.sessionId}:${all.length}`, item }].slice(-KEEP);
      }),
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-aai-bg p-5 text-aai-text">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Front Door</h1>
        <span className="text-xs opacity-60">{connected ? "Listening" : "Reconnecting…"}</span>
      </header>

      <section aria-label="At the door now" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">At the door</h2>
        {live.length === 0 ? (
          <p className="text-sm opacity-50">Nobody's talking to the door.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {live.map(({ key, item }) => (
              <li key={key}>
                {item.kind === "message"
                  ? `${item.message.role === "user" ? "Visitor" : "Door"}: ${item.message.content}`
                  : item.kind === "tool"
                    ? `(${item.toolCall.name})`
                    : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Messages" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Messages</h2>
          <button
            type="button"
            className="text-xs underline disabled:opacity-40"
            disabled={busy !== undefined}
            onClick={() => void run("POST", "/digest", undefined, { key: "digest" })}
          >
            {busy ? "Asking…" : "Summarize today"}
          </button>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        {notices.length === 0 ? (
          <p className="text-sm opacity-50">No messages yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {notices.map((n) => (
              <li
                key={n.id}
                className="rounded-lg border border-aai-border bg-aai-surface px-3 py-2 text-sm"
              >
                <span className="block">{n.line}</span>
                <span className="text-xs opacity-60">{new Date(n.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <button
        type="button"
        className="self-start text-xs opacity-50 hover:opacity-100"
        onClick={() => {
          linked.clear();
          location.reload();
        }}
      >
        Unlink this phone
      </button>
    </main>
  );
}

mountClient({
  component: App,
  // Asked on every connection: the door's id once linked, else this browser's own.
  client: linked.id,
  theme: { primary: "#3f7d5a", mode: "light" },
});
