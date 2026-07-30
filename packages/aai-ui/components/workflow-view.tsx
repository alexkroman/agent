// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * Default shell for workflows (`workflow()` definitions) — the SDK's
 * audio-in / action-out mode.
 *
 * Where {@link ChatView} is a *conversation*, this surface is
 * a one-shot *run*: hold the talk button (or upload an audio file) to stage
 * one instruction, press **Go**, and the whole clip goes out as a single
 * `POST /sync` request with **no history** — the server transcribes it, the
 * agentic loop executes the actions with the workflow's tools, and the view
 * shows what was heard and the tool calls that ran. Deliberately **no
 * greeting and no assistant prose** — a workflow is an execution surface,
 * not a chat, so the record of a run is the transcript plus the actions
 * taken. Each run is independent; staging a new clip clears the last
 * result.
 *
 * Built on the same {@link ConsoleShell} chrome as the chat shell, so the
 * two app modes share one visual language by construction. Rendered by
 * `client()` when `GET /client-config` declares
 * `kind: "workflow"`; exported for custom clients that want the stock run
 * surface with their own chrome.
 */

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { decodeAudioToPcm16 } from "../audio.ts";
import { useTheme } from "../context.ts";
import { createPttRecorder, DEFAULT_SYNC_MIC_SAMPLE_RATE, type PttRecorder } from "../sync-mic.ts";
import { createSyncSession, type SyncTurnResult } from "../sync-session.ts";
import type { AgentState, ToolCallInfo } from "../types.ts";
import { ERROR_COLOR, TEXT_FAINT, TEXT_MUTED } from "./_colors.ts";
import { Button } from "./button.tsx";
import { ConsoleShell } from "./console-shell.tsx";
import { ThinkingDots } from "./message-list.tsx";
import { ToolCallBlock } from "./tool-call-block.tsx";
import { UrlChip } from "./url-chips.tsx";

/** One staged instruction clip, ready to run. */
type StagedClip = { pcm: Int16Array; sampleRate: number; source: "recording" | string };

/** One finished run: what was heard and the tool calls that executed. */
type RunResult = { heard: string; toolCalls: ToolCallInfo[] };

/**
 * The sync response's completed tool records, as the shared
 * {@link ToolCallBlock} rows render them. A sync turn only reports once it
 * has fully run, so every call is `done`; the synthetic fallback id keeps
 * render keys stable when a provider omits `toolCallId`.
 */
function toToolCallInfo(turn: SyncTurnResult): ToolCallInfo[] {
  return (turn.toolCalls ?? []).map((call, i) => ({
    callId: call.toolCallId.length > 0 ? call.toolCallId : `run-call-${i}`,
    name: call.toolName,
    args: call.args,
    status: "done",
    result: call.result,
    seq: i,
    afterMessageId: -1,
  }));
}

function clipSeconds(clip: StagedClip): number {
  return clip.pcm.length / clip.sampleRate;
}

/**
 * Map the run lifecycle onto the shared eyebrow states: recording reads as
 * "listening", an in-flight run as "thinking", a finished run as "ready".
 */
function workflowState(opts: {
  error: string | null;
  recording: boolean;
  running: boolean;
}): AgentState {
  if (opts.running) return "thinking";
  if (opts.recording) return "listening";
  if (opts.error) return "error";
  return "ready";
}

/** The output card's body: instruction line, staged clip, then the run result. */
function RunCard({
  clip,
  running,
  result,
}: {
  clip: StagedClip | null;
  running: boolean;
  result: RunResult | null;
}) {
  const theme = useTheme();
  return (
    <div className="flex flex-col gap-5 p-7">
      {clip === null && result === null && !running && (
        <p className="text-sm" style={{ color: TEXT_MUTED }}>
          Hold to talk or upload an audio file, then press Go. The whole clip runs as one
          instruction — the actions it executed appear here.
        </p>
      )}
      {clip && !running && (
        <p className="text-sm" data-testid="staged-clip" style={{ color: TEXT_MUTED }}>
          {clip.source === "recording" ? "Recording" : clip.source} staged (
          {clipSeconds(clip).toFixed(1)}s) — press Go to run it.
        </p>
      )}
      {running && (
        <div data-testid="running">
          <ThinkingDots />
        </div>
      )}
      {result && (
        <div className="flex flex-col gap-1.5" data-testid="run-result">
          <span
            className="text-[10px] font-medium tracking-[1.2px] uppercase leading-none"
            style={{ color: TEXT_FAINT }}
          >
            Heard
          </span>
          <p className="text-[15px] leading-[22px]" style={{ color: theme.text }}>
            {result.heard}
          </p>
          <span
            className="text-[10px] font-medium tracking-[1.2px] uppercase leading-none mt-1.5"
            style={{ color: TEXT_FAINT }}
          >
            Actions
          </span>
          {result.toolCalls.length === 0 ? (
            <p className="text-sm" style={{ color: TEXT_MUTED }}>
              No actions were taken.
            </p>
          ) : (
            <div className="flex flex-col gap-2" data-testid="run-tool-calls">
              {result.toolCalls.map((call) => (
                <ToolCallBlock key={call.callId} toolCall={call} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Workflow run surface: push-to-talk or audio upload stages one instruction
 * clip; **Go** runs it as a single sync turn and shows what was heard plus
 * the tool calls that executed — no greeting, no assistant messages.
 *
 * @public
 */
export function WorkflowView({
  syncUrl,
  title,
}: {
  /** The workflow server's sync endpoint, e.g. `https://host/slug/sync`. */
  syncUrl: string;
  /** Workflow name shown in the header. */
  title?: string | undefined;
}) {
  const [clip, setClip] = useState<StagedClip | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [recording, setRecording] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<PttRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const disposed = useRef(false);

  // Transport only — a workflow run carries no history, so the session is
  // reset before every run rather than accumulating a conversation.
  const sessionRef = useRef(createSyncSession({ url: syncUrl }));

  useEffect(
    () => () => {
      disposed.current = true;
      void recorder.current?.close();
      recorder.current = null;
    },
    [],
  );

  async function holdStart(): Promise<void> {
    if (running || recording) return;
    try {
      recorder.current ??= createPttRecorder();
      await recorder.current.start();
      if (disposed.current) return;
      setRecording(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function holdEnd(): Promise<void> {
    if (!recording) return;
    setRecording(false);
    try {
      const pcm = await recorder.current?.stop();
      if (disposed.current || !pcm) return;
      if (pcm.length === 0) {
        setError("Nothing was recorded — hold the button while you speak.");
        return;
      }
      setClip({ pcm, sampleRate: DEFAULT_SYNC_MIC_SAMPLE_RATE, source: "recording" });
      setResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function stageFile(file: File): Promise<void> {
    try {
      const pcm = await decodeAudioToPcm16(await file.arrayBuffer(), DEFAULT_SYNC_MIC_SAMPLE_RATE);
      if (disposed.current) return;
      if (pcm.length === 0) {
        setError("That file decoded to no audio.");
        return;
      }
      setClip({ pcm, sampleRate: DEFAULT_SYNC_MIC_SAMPLE_RATE, source: file.name });
      setResult(null);
      setError(null);
    } catch {
      setError("Could not decode that file as audio.");
    }
  }

  async function go(): Promise<void> {
    if (!clip || running) return;
    setRunning(true);
    setError(null);
    // Every run stands alone: forget anything a previous run left behind.
    sessionRef.current.reset();
    const outcome = await sessionRef.current.sendPcm16(clip.pcm, clip.sampleRate).then(
      (turn: SyncTurnResult) => ({ turn }),
      (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
    );
    if (disposed.current) return;
    setRunning(false);
    if ("turn" in outcome) {
      setResult({ heard: outcome.turn.transcript, toolCalls: toToolCallInfo(outcome.turn) });
      setClip(null);
    } else {
      // The clip survives a failed run so the user can just press Go again.
      setError(outcome.message);
    }
  }

  const state = workflowState({ error, recording, running });

  // Controls: hold-to-talk, upload, Go, and where the run is sent.
  const controls = (
    <div className="flex items-center gap-2 shrink-0">
      <Button
        size="lg"
        variant={recording ? "default" : "secondary"}
        className="select-none touch-none"
        style={recording ? { background: ERROR_COLOR, borderColor: "transparent" } : undefined}
        disabled={running}
        onPointerDown={() => void holdStart()}
        onPointerUp={() => void holdEnd()}
        onPointerLeave={() => void holdEnd()}
        aria-pressed={recording}
        title="Hold to record your instructions"
      >
        <span
          className={clsx("w-2 h-2 rounded-full mr-2", recording && "animate-pulse")}
          style={{ background: recording ? "#fff" : ERROR_COLOR }}
        />
        {recording ? "Release to stage" : "Hold to talk"}
      </Button>
      <input
        ref={fileInput}
        type="file"
        accept="audio/*"
        className="hidden"
        data-testid="workflow-file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void stageFile(file);
        }}
      />
      <Button
        size="lg"
        variant="secondary"
        disabled={running || recording}
        onClick={() => fileInput.current?.click()}
        title="Upload an audio file of your instructions"
      >
        Upload audio
      </Button>
      <Button
        size="lg"
        disabled={!clip || running || recording}
        onClick={() => void go()}
        data-testid="workflow-go"
        title="Run the staged instructions"
      >
        {running ? "Running…" : "Go"}
      </Button>
      <UrlChip
        label="Run"
        url={syncUrl}
        hint="Each run is one POST to this endpoint"
        testId="sync-url-chip"
        className="ml-auto min-w-0 max-w-[40%]"
      />
    </div>
  );

  return (
    <ConsoleShell
      title={title ?? "Workflow"}
      state={state}
      pulsing={recording || running}
      error={error}
      footer={controls}
    >
      {/* Output card: instruction line, staged clip, then the run result */}
      <div role="log" className="flex-1 overflow-y-auto [scrollbar-width:none]">
        <RunCard clip={clip} running={running} result={result} />
      </div>
    </ConsoleShell>
  );
}
