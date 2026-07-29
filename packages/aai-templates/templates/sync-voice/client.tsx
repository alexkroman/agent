import "@alexkroman1/aai-ui/styles.css";
import {
  client,
  createSyncSession,
  type SyncMicrophone,
  type SyncTurnResult,
  startSyncMicrophone,
  useTheme,
} from "@alexkroman1/aai-ui";
import { useEffect, useRef, useState } from "react";

// Sync-mode client: no WebSocket anywhere. Voice turns are endpointed in
// the browser (WebRTC mic + energy VAD) and each utterance — or each typed
// message — is one `POST /sync` request. The conversation history lives
// here and is replayed with every turn; the server keeps no session state.

// The page is served at the agent's own path (`/:slug/` deployed, `/` in
// `aai dev`), so the sync endpoint is one relative hop away.
const SYNC_URL = new URL("sync", globalThis.location.origin + globalThis.location.pathname).href;

type Line = { id: number; role: "user" | "assistant"; text: string };

/** Play one reply's PCM16 through a shared AudioContext. */
function playReply(ctxRef: { current: AudioContext | null }, turn: SyncTurnResult): void {
  if (!(turn.pcm && turn.sampleRate)) return;
  ctxRef.current ??= new AudioContext();
  const ctx = ctxRef.current;
  const buffer = ctx.createBuffer(1, turn.pcm.length, turn.sampleRate);
  const channel = buffer.getChannelData(0);
  turn.pcm.forEach((sample, i) => {
    channel[i] = sample / 0x80_00;
  });
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
}

function SyncVoiceApp() {
  const theme = useTheme();
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playbackCtx = useRef<AudioContext | null>(null);
  const micRef = useRef<SyncMicrophone | null>(null);

  const sessionRef = useRef(
    createSyncSession({
      url: SYNC_URL,
      onTurn: (turn) => {
        setLines((prev) => [
          ...prev,
          { id: prev.length, role: "user", text: turn.transcript },
          { id: prev.length + 1, role: "assistant", text: turn.reply },
        ]);
        setBusy(false);
        setError(turn.ttsError ? `TTS unavailable: ${turn.ttsError}` : null);
        playReply(playbackCtx, turn);
      },
      onError: (err) => {
        setBusy(false);
        setError(err.message);
      },
    }),
  );

  // Release the mic and audio context when the component unmounts.
  useEffect(
    () => () => {
      void micRef.current?.stop();
      void playbackCtx.current?.close();
    },
    [],
  );

  async function toggleMic(): Promise<void> {
    if (micRef.current) {
      const mic = micRef.current;
      micRef.current = null;
      setMicOn(false);
      await mic.stop();
      return;
    }
    try {
      micRef.current = await startSyncMicrophone({
        session: sessionRef.current,
        onSpeechEnd: () => setBusy(true),
        onError: (err) => setError(err.message),
      });
      setMicOn(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function sendDraft(): void {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setBusy(true);
    sessionRef.current.sendText(text).catch(() => {
      // surfaced via onError
    });
  }

  return (
    <div
      className="flex flex-col h-screen max-w-2xl mx-auto"
      style={{ background: theme.bg, color: theme.text }}
    >
      <header
        className="px-4 py-3 border-b flex items-center justify-between shrink-0"
        style={{ borderColor: theme.border }}
      >
        <h1 className="font-bold">Sync Voice</h1>
        <span className="text-xs opacity-60">HTTP turns — no WebSocket</span>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {lines.length === 0 && (
          <p className="opacity-60 text-sm">
            Turn the mic on and speak — each utterance becomes one HTTP request — or type below.
          </p>
        )}
        {lines.map((line) => (
          <div
            key={line.id}
            className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
              line.role === "user" ? "ml-auto" : ""
            }`}
            style={{
              background: line.role === "user" ? theme.primary : theme.surface,
              color: line.role === "user" ? "#fff" : theme.text,
            }}
          >
            {line.text}
          </div>
        ))}
        {busy && <p className="text-sm opacity-60 animate-pulse">Thinking…</p>}
        {error && (
          <p className="text-sm" style={{ color: "#dc2626" }}>
            {error}
          </p>
        )}
      </main>

      <footer
        className="p-3 border-t flex gap-2 items-center shrink-0"
        style={{ borderColor: theme.border }}
      >
        <button
          type="button"
          onClick={() => void toggleMic()}
          aria-pressed={micOn}
          className="rounded-full w-11 h-11 shrink-0 text-lg"
          style={{
            background: micOn ? "#dc2626" : theme.primary,
            color: "#fff",
          }}
          title={micOn ? "Stop listening" : "Start listening"}
        >
          {micOn ? "■" : "\u{1F3A4}"}
        </button>
        <input
          className="flex-1 rounded-lg px-3 py-2 text-sm border bg-transparent"
          style={{ borderColor: theme.border, color: theme.text }}
          placeholder="Type a message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendDraft();
          }}
        />
        <button
          type="button"
          onClick={sendDraft}
          disabled={busy || draft.trim().length === 0}
          className="rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{ background: theme.primary, color: "#fff" }}
        >
          Send
        </button>
      </footer>
    </div>
  );
}

client({ component: SyncVoiceApp });
