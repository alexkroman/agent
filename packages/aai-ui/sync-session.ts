// Copyright 2026 the AAI authors. MIT license.
/**
 * Sync-mode browser session — HTTP turns, no WebSocket.
 *
 * The client half of the server's `POST /sync` endpoint (see
 * `host/sync-turn.ts` in `@alexkroman1/aai`): each turn is one request
 * carrying committed text or one endpointed utterance of PCM16 audio plus
 * the conversation history, answered with the transcript, the reply text,
 * and (when the agent's TTS provider supports one-shot synthesis) the
 * spoken reply. The server holds no session state — this object owns the
 * history and replays it every turn.
 *
 * Microphone capture and utterance endpointing live in `sync-mic.ts` /
 * `sync-vad.ts`; this module is transport only, so it also runs in
 * non-browser clients that bring their own audio.
 */

import { DEFAULT_MAX_HISTORY, errorMessage, safeJsonParse } from "@alexkroman1/aai";
import {
  type SyncHistoryMessage,
  type SyncTurnResponse,
  SyncTurnResponseSchema,
} from "@alexkroman1/aai/protocol";

/** Base64-encode PCM16 samples (chunked — `btoa` takes a binary string). */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const CHUNK = 0x80_00;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode base64 PCM16LE (the sync response's `audio` field) into samples. */
export function base64ToPcm16(base64: string): Int16Array {
  const binary = atob(base64);
  // Drop a trailing odd byte rather than throwing on a misaligned length.
  const samples = binary.length >> 1;
  const bytes = new Uint8Array(samples * 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, samples);
}

/** One completed sync turn: the wire response plus decoded reply audio. */
export type SyncTurnResult = SyncTurnResponse & {
  /** Decoded reply audio (PCM16 at `sampleRate`), when the server spoke. */
  pcm: Int16Array | null;
};

/** Configuration for {@link createSyncSession}. */
export type SyncSessionOptions = {
  /** The agent server's sync endpoint, e.g. `http://localhost:3000/sync`. */
  url: string;
  /** Fetch override (tests / custom transports). */
  fetch?: typeof globalThis.fetch | undefined;
  /** Called after every completed turn (text and voice alike). */
  onTurn?: ((turn: SyncTurnResult) => void) | undefined;
  /** Called when a turn fails; the rejection still propagates to the caller. */
  onError?: ((err: Error) => void) | undefined;
};

/** Sync-mode session handle. */
export type SyncSession = {
  /** Conversation so far, oldest first — replayed to the server each turn. */
  readonly history: readonly SyncHistoryMessage[];
  /** Run one turn from committed text. */
  sendText(text: string): Promise<SyncTurnResult>;
  /** Run one turn from one utterance of mono PCM16 audio. */
  sendPcm16(pcm: Int16Array, sampleRate: number): Promise<SyncTurnResult>;
  /** Forget the conversation. */
  reset(): void;
};

/** Create a {@link SyncSession} against a sync-mode agent server. */
export function createSyncSession(opts: SyncSessionOptions): SyncSession {
  const fetchFn =
    opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const history: SyncHistoryMessage[] = [];
  // Turns serialize: history must include the previous reply before the
  // next request snapshots it, even when callers fire without awaiting.
  let queue: Promise<unknown> = Promise.resolve();

  async function parseTurn(resp: Response): Promise<SyncTurnResponse> {
    if (!resp.ok) {
      const detail = (safeJsonParse(await resp.text().catch(() => "")) ?? {}) as {
        error?: string;
      };
      throw new Error(
        `Sync turn failed: HTTP ${resp.status}${detail.error ? ` (${detail.error})` : ""}`,
      );
    }
    const parsed = SyncTurnResponseSchema.safeParse(await resp.json());
    if (!parsed.success) {
      // Name the first offending field — "malformed server response" alone
      // gives a bug report nothing to go on.
      const issue = parsed.error.issues[0];
      const detail = issue ? ` (${issue.path.join(".") || "body"}: ${issue.message})` : "";
      throw new Error(`Sync turn failed: malformed server response${detail}`);
    }
    return parsed.data;
  }

  async function runTurn(body: Record<string, unknown>): Promise<SyncTurnResult> {
    try {
      const resp = await fetchFn(opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, history: [...history] }),
      });
      const turn = await parseTurn(resp);
      history.push({ role: "user", content: turn.transcript });
      if (turn.reply.length > 0) history.push({ role: "assistant", content: turn.reply });
      // Slide the window at the server's own history size. Growing past it
      // buys nothing — `runSyncTurn` trims to DEFAULT_MAX_HISTORY before the
      // LLM sees it — while every turn replays the whole array, so an
      // unbounded client made request bodies grow without limit and, past
      // MAX_SYNC_HISTORY_MESSAGES, got every later turn rejected outright.
      if (history.length > DEFAULT_MAX_HISTORY) {
        history.splice(0, history.length - DEFAULT_MAX_HISTORY);
      }
      const result: SyncTurnResult = {
        ...turn,
        pcm: turn.audio !== undefined ? base64ToPcm16(turn.audio) : null,
      };
      opts.onTurn?.(result);
      return result;
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(errorMessage(err));
      opts.onError?.(wrapped);
      throw wrapped;
    }
  }

  function enqueue(body: Record<string, unknown>): Promise<SyncTurnResult> {
    // Chain on settle (not success) so one failed turn doesn't poison the queue.
    const next = queue.then(
      () => runTurn(body),
      () => runTurn(body),
    );
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    get history() {
      return history;
    },
    sendText(text: string) {
      return enqueue({ text });
    },
    sendPcm16(pcm: Int16Array, sampleRate: number) {
      return enqueue({ audio: pcm16ToBase64(pcm), sampleRate });
    },
    reset() {
      history.length = 0;
    },
  };
}
