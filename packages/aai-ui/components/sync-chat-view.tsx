// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * Default shell for sync-transport agents (`agent({ transport: "sync" })`).
 *
 * A hands-free voice agent: one toggle starts the conversation, and from
 * then on the mic stays open — `startSyncMicrophone` runs the WebRTC
 * voice-processing capture through the energy VAD (`sync-vad.ts`), which
 * endpoints each utterance automatically and sends it as one `POST /sync`
 * request through `createSyncSession`. No button per turn: speak, pause,
 * and the reply comes back and plays. The view shows what was heard, the
 * agent's reply, and — via the endpoint chip next to the toggle — exactly
 * where each utterance is being sent.
 *
 * Visually it is the same "voice agent console" as the WebSocket
 * {@link ChatView}: header with logo + live-status eyebrow, the output on a
 * raised card, controls beneath — built from the same shared pieces
 * ({@link ThinkingDots}, {@link Eyebrow}, {@link Button}, {@link UrlChip})
 * so the two transports are indistinguishable at a glance.
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
import { ERROR_COLOR, TEXT_FAINT, TEXT_MUTED } from "./_colors.ts";
import { AaiLogo } from "./aai-logo.tsx";
import { Button } from "./button.tsx";
import { stateColor } from "./chat-view.tsx";
import { Eyebrow } from "./eyebrow.tsx";
import { ThinkingDots } from "./message-list.tsx";
import { UrlChip } from "./url-chips.tsx";

/** One completed turn: what the agent heard and what it answered. */
type Exchange = { id: number; heard: string; reply: string };

/**
 * Play one reply's PCM16 through a shared AudioContext. `onPlaying`
 * tracks playback so the eyebrow can show "speaking" while the reply is
 * audible.
 */
function playReply(
  ctxRef: { current: AudioContext | null },
  turn: SyncTurnResult,
  onPlaying: (playing: boolean) => void,
): void {
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
  source.onended = () => onPlaying(false);
  onPlaying(true);
  source.start();
}

/**
 * Map the hands-free conversation lifecycle onto the same states the
 * WebSocket eyebrow shows, so the status chip reads identically across
 * transports: an endpointed utterance in flight is "thinking", an audible
 * reply is "speaking", a live mic is "listening".
 */
function syncState(opts: {
  error: string | null;
  live: boolean;
  pending: number;
  agentSpeaking: boolean;
}): AgentState {
  if (opts.pending > 0) return "thinking";
  if (opts.agentSpeaking) return "speaking";
  if (opts.live) return "listening";
  if (opts.error) return "error";
  return "ready";
}

/**
 * Sync-transport view: a hands-free VAD-endpointed conversation, transcript
 * + reply output, and the endpoint each utterance is POSTed to — one HTTP
 * request per turn.
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
   * Greeting shown as the card's opening line. Sync turns have no session
   * start for the server to speak it on, so it is display-only.
   */
  greeting?: string | undefined;
}) {
  const theme = useTheme();
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [live, setLive] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [pending, setPending] = useState(0);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playbackCtx = useRef<AudioContext | null>(null);
  const mic = useRef<SyncMicrophone | null>(null);
  const toggling = useRef(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const sessionRef = useRef(
    createSyncSession({
      url: syncUrl,
      onTurn: (turn) => {
        setExchanges((prev) => [
          ...prev,
          { id: prev.length, heard: turn.transcript, reply: turn.reply },
        ]);
        setPending((n) => Math.max(0, n - 1));
        setError(turn.ttsError ? `TTS unavailable: ${turn.ttsError}` : null);
        playReply(playbackCtx, turn, setAgentSpeaking);
      },
      onError: (err) => {
        setPending((n) => Math.max(0, n - 1));
        setError(err.message);
      },
    }),
  );

  // Release the mic and audio context when the component unmounts.
  useEffect(
    () => () => {
      void mic.current?.stop();
      void playbackCtx.current?.close();
    },
    [],
  );

  // Keep the newest exchange in view as turns land (and when the thinking
  // indicator appears): scroll whenever the card's content count advances.
  const contentCount = exchanges.length + (pending > 0 ? 1 : 0);
  useEffect(() => {
    if (contentCount === 0) return;
    anchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [contentCount]);

  async function toggleConversation(): Promise<void> {
    if (toggling.current) return;
    toggling.current = true;
    try {
      if (mic.current) {
        const handle = mic.current;
        mic.current = null;
        setLive(false);
        setUserSpeaking(false);
        // stop() flushes a trailing utterance, so a turn may still land.
        await handle.stop();
        return;
      }
      mic.current = await startSyncMicrophone({
        session: sessionRef.current,
        onSpeechStart: () => setUserSpeaking(true),
        onSpeechEnd: () => {
          setUserSpeaking(false);
          setPending((n) => n + 1);
        },
        onError: (err) => setError(err.message),
      });
      setLive(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      toggling.current = false;
    }
  }

  const state = syncState({ error, live, pending, agentSpeaking });
  const buttonLabel = live ? "End conversation" : "Start conversation";
  const pulsing = userSpeaking || agentSpeaking;

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
      {/* Output card: what was heard, what the agent answered */}
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
          <div className="flex flex-col gap-5 p-7">
            {greeting !== undefined && greeting.length > 0 && (
              <p className="text-[15px] leading-[23px]" style={{ color: theme.text }}>
                {greeting}
              </p>
            )}
            {exchanges.length === 0 && (
              <p className="text-sm" style={{ color: TEXT_MUTED }}>
                Start the conversation and just talk — each pause endpoints an utterance, which goes
                out as one HTTP request to the endpoint below.
              </p>
            )}
            {exchanges.map((ex) => (
              <div key={ex.id} className="flex flex-col gap-1.5">
                <span
                  className="text-[10px] font-medium tracking-[1.2px] uppercase leading-none"
                  style={{ color: TEXT_FAINT }}
                >
                  Heard
                </span>
                <p className="text-[15px] leading-[22px]" style={{ color: TEXT_MUTED }}>
                  {ex.heard}
                </p>
                <span
                  className="text-[10px] font-medium tracking-[1.2px] uppercase leading-none mt-1.5"
                  style={{ color: TEXT_FAINT }}
                >
                  Agent
                </span>
                <p
                  className="whitespace-pre-wrap wrap-break-word text-[15px] font-normal leading-[23px]"
                  style={{ color: theme.text }}
                >
                  {ex.reply}
                </p>
              </div>
            ))}
            {pending > 0 && (
              <div data-testid="thinking">
                <ThinkingDots />
              </div>
            )}
            <div ref={anchorRef} />
          </div>
        </div>
      </div>
      {/* Controls: conversation toggle + where each utterance is sent */}
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="lg"
          variant={live ? "default" : "secondary"}
          className="select-none"
          style={live ? { background: ERROR_COLOR, borderColor: "transparent" } : undefined}
          onClick={() => void toggleConversation()}
          aria-pressed={live}
          title="Start or end the conversation"
        >
          <span
            className={clsx("w-2 h-2 rounded-full mr-2", pulsing && "animate-pulse")}
            style={{ background: live ? "#fff" : ERROR_COLOR }}
          />
          {buttonLabel}
        </Button>
        <UrlChip
          label="Sync"
          url={syncUrl}
          hint="Each utterance is one POST to this endpoint"
          testId="sync-url-chip"
          className="ml-auto min-w-0 max-w-[55%]"
        />
      </div>
    </div>
  );
}
