// Copyright 2026 the AAI authors. MIT license.
/**
 * Host opener for `assemblyAISyncStt()` — a request/response transcription
 * model (`POST /v1/transcribe`) run as a turn-taking STT stage.
 *
 * The endpoint takes one audio file and answers one transcript, so the
 * endpointing a streaming service owns is done HERE:
 *
 * - audio is cut into {@link VAD_BLOCK_MS} blocks; a block louder than
 *   `speechThresholdDbfs` is voiced (default -30 dBFS — the measurement that
 *   chose it, and why Silero VAD was not used, is on its constant in the SDK);
 * - {@link SPEECH_START_MS} of consecutive voiced blocks opens a turn, which
 *   keeps the last {@link PREROLL_MS} before it so the first syllable is not
 *   clipped;
 * - `minTurnSilenceMs` of unvoiced audio after the last voiced block ends it
 *   (as does `forceEndOfTurn`, or {@link MAX_TURN_MS}), and the turn's audio
 *   is posted as a WAV — the answer is the `final`;
 * - while the turn is open, the audio so far is re-posted every
 *   `partialIntervalMs` for a `partial`, one request at a time, and an answer
 *   that lands after its turn closed is dropped.
 *
 * Finals are emitted in turn order (one chain), and a final whose transcript is
 * blank — a turn the model heard only noise in — is dropped, as the local
 * opener drops one. A failed final is a stream error, which ends the session; a
 * failed partial is skipped, since the final will be asked for anyway.
 */

import type { AssemblyAISyncSttOptions } from "@alexkroman1/aai/experimental";
import {
  ASSEMBLYAI_SYNC_API_KEY_ENV,
  ASSEMBLYAI_SYNC_DEFAULT_PROMPT,
  resolveAssemblyAISyncSttSettings,
} from "@alexkroman1/aai/host-internal";
import { errorMessage, isRecord } from "@alexkroman1/aai/utils";
import { createNanoEvents, type Emitter } from "nanoevents";
import { modelFetch } from "../../_egress-fetch.ts";
import { closeOnAbort, createSttSessionShell, requireApiKey } from "../_utils.ts";
import {
  createSttError,
  type SttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
  type SttTurnMeta,
} from "../openers.ts";
import { createInputLevelLedger, rmsDbfs } from "./_input-level-ledger.ts";

/** Width of one level decision, in ms. */
export const VAD_BLOCK_MS = 20;
/** Consecutive voiced audio that opens a turn, in ms — shorter is a click. */
export const SPEECH_START_MS = 60;
/** Audio kept from before the turn opened, in ms. */
export const PREROLL_MS = 300;
/** The longest turn, in ms; past it the turn is ended as `forceEndOfTurn` would. */
export const MAX_TURN_MS = 60_000;
/** Deadline on one transcribe request, in ms. */
export const TRANSCRIBE_TIMEOUT_MS = 15_000;

const LABEL = "AssemblyAI sync STT";

/** One word of the endpoint's answer, times in ms into the posted audio. */
type SyncWord = { start: number; end: number };

/** What a transcribe request answered, probed field by field. */
export type SyncTranscript = { text: string; words: SyncWord[] };

/** The 44-byte RIFF header + PCM16 mono `pcm`, as the endpoint's `audio` part. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i] as number, true);
  return out;
}

/**
 * The `multipart/form-data` body, built as bytes: a `FormData` through the
 * pinned egress fetch is silently stringified (`host/_undici.ts`).
 */
export function buildTranscribeBody(
  wav: Uint8Array,
  prompt: string,
  boundary: string,
): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="config"\r\n\r\n${JSON.stringify({ prompt })}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="turn.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + wav.length + tail.length);
  body.set(head, 0);
  body.set(wav, head.length);
  body.set(tail, head.length + wav.length);
  return body;
}

/** Read the endpoint's JSON answer; anything malformed is no text and no words. */
export function parseTranscript(body: unknown): SyncTranscript {
  if (!isRecord(body)) return { text: "", words: [] };
  const text = typeof body.text === "string" ? body.text : "";
  const words: SyncWord[] = [];
  if (Array.isArray(body.words)) {
    for (const w of body.words) {
      if (isRecord(w) && typeof w.start === "number" && typeof w.end === "number") {
        words.push({ start: w.start, end: w.end });
      }
    }
  }
  return { text, words };
}

/** The `fetch` the opener posts with — a seam so the unit tier needs no network. */
export type SyncSttFetch = typeof globalThis.fetch;

/**
 * A turn segmenter over per-block speech decisions — pure, so the unit tier
 * drives it block by block. Which gate decides and how wide
 * a block is are the caller's; every duration here is converted to blocks of
 * that width. `onTurnEnd` receives the turn's audio and its offset on the
 * session's audio axis; `onPartialDue` the audio so far.
 */
export interface TurnSegmenter {
  pushBlock(block: Int16Array, voiced: boolean): void;
  /** End the open turn now, if one is open. */
  forceEnd(): void;
  setMinTurnSilenceMs(ms: number): void;
  /** Is a turn open? */
  inTurn(): boolean;
  /** Which turn is open (or was last), so a late answer can tell it is stale. */
  turnId(): number;
}

export function createTurnSegmenter(opts: {
  sampleRate: number;
  blockSamples: number;
  minTurnSilenceMs: number;
  partialIntervalMs: number;
  onTurnEnd: (pcm: Int16Array, startMs: number, turnId: number) => void;
  onPartialDue: (pcm: Int16Array, startMs: number, turnId: number) => void;
}): TurnSegmenter {
  const { blockSamples } = opts;
  const blockMs = (blockSamples * 1000) / opts.sampleRate;
  const msToBlocks = (ms: number): number => Math.max(1, Math.ceil(ms / blockMs));
  const prerollBlocks = msToBlocks(PREROLL_MS);
  const startBlocks = msToBlocks(SPEECH_START_MS);
  const maxTurnBlocks = msToBlocks(MAX_TURN_MS);
  const partialBlocks = opts.partialIntervalMs > 0 ? msToBlocks(opts.partialIntervalMs) : 0;
  let silenceBlocksToEnd = msToBlocks(opts.minTurnSilenceMs);

  /** Blocks completed since the session opened — the audio axis. */
  let blockIndex = 0;
  /** Recent blocks while idle (pre-roll); the whole turn while in one. */
  let blocks: Int16Array[] = [];
  let firstBlockIndex = 0;
  let voicedRun = 0;
  let silentRun = 0;
  let open = false;
  let id = 0;
  let blocksAtLastPartial = 0;

  const concat = (): Int16Array => {
    const out = new Int16Array(blocks.length * blockSamples);
    for (const [i, b] of blocks.entries()) out.set(b, i * blockSamples);
    return out;
  };
  const startMs = (): number => firstBlockIndex * blockMs;

  const end = (): void => {
    if (!open) return;
    // Trailing silence past a short tail is endpointing budget, not speech:
    // keep the pre-roll's worth so the last word's release is not cut.
    const keep = Math.max(0, silentRun - prerollBlocks);
    if (keep > 0) blocks = blocks.slice(0, blocks.length - keep);
    const pcm = concat();
    const at = startMs();
    open = false;
    blocks = [];
    voicedRun = 0;
    silentRun = 0;
    opts.onTurnEnd(pcm, at, id);
  };

  const onIdleBlock = (voiced: boolean): void => {
    voicedRun = voiced ? voicedRun + 1 : 0;
    if (blocks.length > prerollBlocks + startBlocks) blocks.shift();
    if (voicedRun < startBlocks) return;
    open = true;
    id += 1;
    silentRun = 0;
    blocksAtLastPartial = 0;
    firstBlockIndex = blockIndex - blocks.length;
  };

  return {
    pushBlock(block: Int16Array, voiced: boolean): void {
      blocks.push(block);
      blockIndex += 1;
      if (!open) {
        onIdleBlock(voiced);
        return;
      }
      silentRun = voiced ? 0 : silentRun + 1;
      if (silentRun >= silenceBlocksToEnd || blocks.length >= maxTurnBlocks) {
        end();
        return;
      }
      if (partialBlocks > 0 && blocks.length - blocksAtLastPartial >= partialBlocks) {
        blocksAtLastPartial = blocks.length;
        opts.onPartialDue(concat(), startMs(), id);
      }
    },
    forceEnd: end,
    setMinTurnSilenceMs(ms: number): void {
      silenceBlocksToEnd = msToBlocks(ms);
    },
    inTurn: () => open,
    turnId: () => id,
  };
}

/**
 * Cut arbitrary frames into fixed blocks of `blockSamples`, carrying the
 * remainder across calls, so a block always spans the same audio however the
 * frames were cut.
 */
export function createBlocker(
  blockSamples: number,
  onBlock: (block: Int16Array) => void,
): (pcm: Int16Array) => void {
  let pending = new Int16Array(blockSamples);
  let pendingLen = 0;
  return (pcm) => {
    let i = 0;
    while (i < pcm.length) {
      const take = Math.min(pcm.length - i, blockSamples - pendingLen);
      pending.set(pcm.subarray(i, i + take), pendingLen);
      pendingLen += take;
      i += take;
      if (pendingLen === blockSamples) {
        onBlock(pending);
        pending = new Int16Array(blockSamples);
        pendingLen = 0;
      }
    }
  };
}

/** Is `block` louder than `thresholdDbfs` (RMS)? The level gate. */
export function levelVoiced(block: Int16Array, thresholdDbfs: number): boolean {
  let sum = 0;
  for (const s of block) sum += s * s;
  return rmsDbfs(sum, block.length) >= thresholdDbfs;
}

export function openAssemblyAISyncStt(
  opts: AssemblyAISyncSttOptions = {},
  fetchImpl: SyncSttFetch = modelFetch,
): SttOpener {
  return {
    name: "assemblyai-sync",
    async open(openOpts: SttOpenOptions): Promise<SttSession> {
      const apiKey = requireApiKey(
        openOpts.apiKey,
        opts.apiKeyEnv ?? ASSEMBLYAI_SYNC_API_KEY_ENV,
        LABEL,
        (msg) => createSttError("stt_auth_failed", msg),
      );
      const settings = resolveAssemblyAISyncSttSettings(opts);
      // An empty `sttPrompt` is "none", as AssemblyAI's is: the default applies.
      const agentPrompt = openOpts.sttPrompt ? openOpts.sttPrompt : undefined;
      const prompt = settings.prompt ?? agentPrompt ?? ASSEMBLYAI_SYNC_DEFAULT_PROMPT;
      const { sampleRate } = openOpts;
      const blockSamples = Math.max(1, Math.round((sampleRate * VAD_BLOCK_MS) / 1000));
      const inflight = new AbortController();
      const emitter: Emitter<SttEvents> = createNanoEvents<SttEvents>();
      const shell = createSttSessionShell({ emitter, teardown: () => inflight.abort() });
      closeOnAbort(openOpts.signal, shell.close);
      const ledger = createInputLevelLedger(sampleRate);

      const transcribe = async (pcm: Int16Array): Promise<SyncTranscript> => {
        const boundary = `aai-${crypto.randomUUID()}`;
        const res = await fetchImpl(settings.url, {
          method: "POST",
          headers: {
            Authorization: apiKey,
            "X-AAI-Model": settings.model,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body: buildTranscribeBody(encodeWav(pcm, sampleRate), prompt, boundary),
          signal: AbortSignal.any([inflight.signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)]),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          throw createSttError(
            res.status === 401 || res.status === 403 ? "stt_auth_failed" : "stt_stream_error",
            `${LABEL}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`,
          );
        }
        return parseTranscript(await res.json());
      };

      /** Word timings → the turn meta, on the session's audio axis. */
      const metaOf = (t: SyncTranscript, startMs: number): SttTurnMeta | undefined => {
        const first = t.words[0];
        const last = t.words.at(-1);
        if (first === undefined || last === undefined) return undefined;
        const peak = ledger.peakDbfs(startMs + first.start, startMs + last.end);
        return {
          spokenMs: Math.max(0, last.end - first.start),
          trailingSilenceMs: Math.max(0, ledger.sentMs() - (startMs + last.end)),
          ...(peak === undefined ? {} : { inputPeakDbfs: peak }),
        };
      };

      /** A failed final ends the session; a refused key says so by its code. */
      const failFinal = (err: unknown): void => {
        if (shell.isClosed()) return;
        if ((err as { code?: unknown }).code === "stt_auth_failed") {
          shell.emit("error", err as SttError);
          void shell.close();
          return;
        }
        shell.streamError(`${LABEL}: ${errorMessage(err)}`);
      };

      let finals: Promise<void> = Promise.resolve();
      let partialInFlight = false;

      const segmenter = createTurnSegmenter({
        sampleRate,
        blockSamples,
        minTurnSilenceMs: settings.minTurnSilenceMs,
        partialIntervalMs: settings.partialIntervalMs,
        onTurnEnd(pcm, startMs) {
          // Settled at once, so a rejection waiting behind an earlier final
          // is never unhandled; chained, so finals reach the transport in
          // turn order whichever request answers first.
          const pending = transcribe(pcm).then(
            (t) => ({ t }),
            (err: unknown) => ({ err }),
          );
          finals = finals.then(async () => {
            const r = await pending;
            if ("err" in r) return failFinal(r.err);
            if (r.t.text.trim().length > 0) shell.emit("final", r.t.text, metaOf(r.t, startMs));
          });
        },
        onPartialDue(pcm, startMs, turnId) {
          if (partialInFlight) return;
          partialInFlight = true;
          transcribe(pcm)
            .then((t) => {
              const live = segmenter.inTurn() && segmenter.turnId() === turnId;
              if (live && t.text.trim().length > 0) {
                shell.emit("partial", t.text, metaOf(t, startMs));
              }
            })
            .catch(() => undefined)
            .finally(() => {
              partialInFlight = false;
            });
        },
      });

      const push = createBlocker(blockSamples, (block) =>
        segmenter.pushBlock(block, levelVoiced(block, settings.speechThresholdDbfs)),
      );

      return {
        sendAudio(pcm: Int16Array): void {
          if (shell.isClosed()) return;
          ledger.record(pcm);
          push(pcm);
        },
        on: shell.on,
        close: shell.close,
        updateEndpointing(minTurnSilenceMs: number): void {
          segmenter.setMinTurnSilenceMs(minTurnSilenceMs);
        },
        forceEndOfTurn(): void {
          segmenter.forceEnd();
        },
      };
    },
  };
}
