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
 * Visually it is the same "voice agent console" as the WebSocket
 * {@link ChatView}: header with logo + live-status eyebrow, the conversation
 * on a raised card, controls beneath — built from the same shared pieces
 * ({@link MessageBubble}, {@link ThinkingDots}, {@link Eyebrow},
 * {@link Button}) so the two transports are indistinguishable at a glance.
 *
 * Rendered by `client()` when the agent's `GET /client-config` declares
 * `transport: "sync"`; also exported for custom clients that want the stock
 * sync UI with their own chrome around it.
 */

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../context.ts";
import { type SyncMicrophone, startSyncMicrophone } from "../sync-mic.ts";
import { createSyncSession, type SyncTurnResult } from "../sync-session.ts";
import type { AgentState } from "../types.ts";
import { ERROR_COLOR, TEXT_MUTED } from "./_colors.ts";
import { AaiLogo } from "./aai-logo.tsx";
import { Button } from "./button.tsx";
import { stateColor } from "./chat-view.tsx";
import { Eyebrow } from "./eyebrow.tsx";
import { MessageBubble, ThinkingDots } from "./message-list.tsx";

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
 * Map the sync turn lifecycle onto the same states the WebSocket eyebrow
 * shows, so the status chip reads identically across transports.
 */
function syncState(error: string | null, busy: boolean, micOn: boolean): AgentState {
  if (error) return "error";
  if (busy) return "thinking";
  if (micOn) return "listening";
  return "ready";
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
  const anchorRef = useRef<HTMLDivElement>(null);

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

  // Keep the newest exchange in view as turns land.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lines/busy drive the scroll, not the effect body
  useEffect(() => {
    anchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines, busy]);

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

  const state = syncState(error, busy, micOn);
  const pulsing = state === "listening";

  return (
    <div
      className="flex flex-col h-screen w-full max-w-190 mx-auto box-border px-6 py-8 gap-5 font-aai text-sm"
      style={{ background: theme.bg, color: theme.text }}
    >
      {/* Header: brand left, live status right */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <AaiLogo size={22} />
          <span
            className="font-aai-serif text-[22px] leading-[1.2] font-normal truncate"
            style={{ color: theme.text }}
          >
            {title ?? "Voice Agent"}
          </span>
        </div>
        <Eyebrow className="shrink-0" data-state={state}>
          <span
            className="w-[7px] h-[7px] rounded-full"
            style={{
              background: stateColor(state, theme.primary),
              animation: pulsing ? "aai-pulse 1.6s ease-in-out infinite" : "none",
            }}
          />
          {state}
        </Eyebrow>
      </div>
      {/* Error banner */}
      {error && (
        <div
          className="px-3.5 py-2.5 rounded-aai border text-[13px] leading-[130%] shrink-0"
          style={{
            borderColor: "rgba(179,38,30,0.35)",
            background: "rgba(179,38,30,0.06)",
            color: ERROR_COLOR,
          }}
        >
          {error}
        </div>
      )}
      {/* Conversation card */}
      <div
        className="flex flex-col flex-1 min-h-0 border rounded-lg overflow-hidden"
        style={{
          background: theme.surface,
          borderColor: theme.border,
          boxShadow: "0 1px 3px 0 rgb(20 18 12 / 0.06)",
        }}
      >
        <div
          role="log"
          className="flex-1 overflow-y-auto [scrollbar-width:none]"
          style={{ background: theme.surface }}
        >
          <div className="flex flex-col gap-4 p-7">
            {greeting !== undefined && greeting.length > 0 && (
              <MessageBubble message={{ role: "assistant", content: greeting }} theme={theme} />
            )}
            {lines.length === 0 && (
              <p className="text-sm" style={{ color: TEXT_MUTED }}>
                Turn the mic on and speak — each utterance becomes one HTTP request — or type below.
              </p>
            )}
            {lines.map((line) => (
              <MessageBubble
                key={line.id}
                message={{ role: line.role, content: line.text }}
                theme={theme}
              />
            ))}
            {busy && (
              <div data-testid="thinking">
                <ThinkingDots />
              </div>
            )}
            <div ref={anchorRef} />
          </div>
        </div>
      </div>
      {/* Controls: mic toggle + composer, styled like the WebSocket controls */}
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant={micOn ? "default" : "secondary"}
          onClick={() => void toggleMic()}
          aria-pressed={micOn}
          style={micOn ? { background: ERROR_COLOR, borderColor: "transparent" } : undefined}
          title={micOn ? "Stop listening" : "Start listening"}
        >
          <span
            className={clsx("w-2 h-2 rounded-full mr-2", micOn && "animate-pulse")}
            style={{ background: micOn ? "#fff" : ERROR_COLOR }}
          />
          {micOn ? "Stop listening" : "Start listening"}
        </Button>
        <input
          className="flex-1 h-9 rounded-aai px-3 text-sm border bg-transparent outline-none"
          style={{ borderColor: theme.border, color: theme.text }}
          placeholder="Type a message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendDraft();
          }}
        />
        <Button onClick={sendDraft} disabled={busy || draft.trim().length === 0}>
          Send
        </Button>
      </div>
    </div>
  );
}
