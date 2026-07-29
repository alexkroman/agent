// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * Default chat shell for sync-transport agents (`agent({ transport: "sync" })`).
 *
 * No WebSocket anywhere: voice turns are endpointed in the browser (WebRTC
 * mic + energy VAD via `startSyncMicrophone`) and each utterance — or each
 * typed message — is one `POST /sync` request through `createSyncSession`.
 * The conversation history lives client-side and replays with every turn.
 *
 * Rendered by `client()` when the agent's `GET /client-config` declares
 * `transport: "sync"`; also exported for custom clients that want the stock
 * sync UI with their own chrome around it.
 */

import { useEffect, useRef, useState } from "react";
import { useTheme } from "../context.ts";
import { type SyncMicrophone, startSyncMicrophone } from "../sync-mic.ts";
import { createSyncSession, type SyncTurnResult } from "../sync-session.ts";
import { TEXT_MUTED } from "./_colors.ts";

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

/**
 * Sync-transport chat view: mic toggle (client-side VAD), text composer,
 * message list, and spoken-reply playback — one HTTP request per turn.
 *
 * @public
 */
export function SyncChatView({
  syncUrl,
  title,
  greeting,
}: {
  /** The agent server's sync endpoint, e.g. `https://host/slug/sync`. */
  syncUrl: string;
  /** Agent name shown in the header. */
  title?: string | undefined;
  /**
   * Greeting shown as the opening assistant message. Sync turns have no
   * session start for the server to speak it on, so it is display-only.
   */
  greeting?: string | undefined;
}) {
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
      url: syncUrl,
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
      className="flex flex-col h-screen max-w-2xl mx-auto font-aai"
      style={{ background: theme.bg, color: theme.text }}
    >
      <header
        className="px-4 py-3 border-b flex items-center justify-between shrink-0"
        style={{ borderColor: theme.border }}
      >
        <h1 className="font-bold">{title ?? "Voice Agent"}</h1>
        <span className="text-xs opacity-60">HTTP turns — no WebSocket</span>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {greeting !== undefined && greeting.length > 0 && (
          <div
            className="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
            style={{ background: theme.surface, color: theme.text }}
          >
            {greeting}
          </div>
        )}
        {lines.length === 0 && (
          <p className="text-sm" style={{ color: TEXT_MUTED }}>
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
