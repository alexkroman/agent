// Copyright 2026 the AAI authors. MIT license.
/**
 * The MODEL for the pipeline transport's randomized interleaving fuzz
 * (`pipeline-fuzz.integration.test.ts`): what a real provider would reject in an
 * LLM request, what a real client may observe (`createCallbacks` — every
 * `TransportCallbacks` entry, wired to the oracles), and the state those oracles
 * share (`Monitor`). fast-check supplies the randomness now, so there is no PRNG
 * here.
 *
 * Kept out of the spec so each piece stays small enough to read on its own, and
 * so the spec is the properties, the driver and the coverage floors rather than
 * their plumbing.
 *
 * @internal Test infrastructure, not part of any public API.
 */

import type { createFakeLanguageModel, FakeTtsProvider } from "../_pipeline-test-fakes.ts";
import type { TransportCallbacks } from "../transports/types.ts";

const noop = (): void => undefined;

/** Collapse whitespace so a text comparison is about content, not chunking. */
export function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** One message of a `LanguageModelV3` prompt, as far as the oracle cares. */
export interface PromptMsg {
  role: string;
  content: unknown;
}

interface ToolIds {
  called: Map<string, number>;
  resulted: Map<string, number>;
}

/** Index every tool-call and tool-result id in a prompt by message position. */
function collectToolIds(prompt: readonly unknown[]): ToolIds {
  const called = new Map<string, number>();
  const resulted = new Map<string, number>();
  for (const [i, raw] of prompt.entries()) {
    const content = (raw as PromptMsg).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; toolCallId?: string };
      if (p.toolCallId === undefined) continue;
      if (p.type === "tool-call") called.set(p.toolCallId, i);
      else if (p.type === "tool-result") resulted.set(p.toolCallId, i);
    }
  }
  return { called, resulted };
}

/** Empty content, which Anthropic rejects. */
function contentProblems(prompt: readonly unknown[]): string[] {
  const problems: string[] = [];
  for (const [i, raw] of prompt.entries()) {
    const m = raw as PromptMsg;
    if (Array.isArray(m.content)) {
      if (m.content.length === 0) problems.push(`msg[${i}] role=${m.role} empty content array`);
    } else if (typeof m.content === "string" && m.content.length === 0) {
      problems.push(`msg[${i}] role=${m.role} empty string content`);
    }
  }
  return problems;
}

/**
 * Unmatched tool calls and results. Both providers reject these outright —
 * OpenAI with "messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'", Anthropic with an unexpected-`tool_result` error
 * — so a history carrying one fails every turn until it scrolls out.
 */
function pairingProblems({ called, resulted }: ToolIds): string[] {
  const problems: string[] = [];
  for (const [id, at] of called) {
    const resultAt = resulted.get(id);
    if (resultAt === undefined) problems.push(`dangling tool-call ${id} (msg[${at}])`);
    else if (resultAt < at) problems.push(`tool-result ${id} precedes its call`);
  }
  for (const [id, at] of resulted) {
    if (!called.has(id)) problems.push(`orphan tool-result ${id} (msg[${at}])`);
  }
  return problems;
}

/**
 * Validate one LLM request the way a real provider would, returning every
 * problem found. This is the fuzz's strongest oracle: it turns "would this 400?"
 * into a check that needs no API key.
 */
export function promptProblems(prompt: unknown): string[] {
  if (!Array.isArray(prompt)) return ["prompt is not an array"];
  return [...contentProblems(prompt), ...pairingProblems(collectToolIds(prompt))];
}

/**
 * Report when a provider stream's lifetime ends, for the turn-serialization
 * probe: on abort, or when the stream drains.
 *
 * Both halves are load-bearing and both were wrong in the first draft. An
 * ALREADY-aborted signal never fires `abort`, so a turn aborted before its
 * stream opened would stay counted as live; and an aborted stream's
 * provider-side tail legitimately outlives its turn (the request is cancelled,
 * its bytes just have not stopped arriving), so waiting for the drain alone
 * reports an overlap on every barge-in. Returns the stream branch the caller
 * should hand back to the SDK.
 */
export function trackStreamLifetime<T>(
  stream: ReadableStream<T>,
  signal: AbortSignal | undefined,
  onSettle: () => void,
): ReadableStream<T> {
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    onSettle();
  };
  if (signal?.aborted === true) settle();
  else signal?.addEventListener("abort", settle, { once: true });

  const [forSdk, forProbe] = stream.tee();
  void (async () => {
    const reader = forProbe.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // A cancelled branch is a settled branch.
    } finally {
      settle();
    }
  })();
  return forSdk;
}

/** Per-reply record backing the integrity and truncation oracles. */
export interface ReplyRecord {
  id: string;
  /** `tts.textChunks` length when this reply started. */
  ttsOffset: number;
  /** Text the model produced for it, accumulated per consumed script step. */
  expected: string;
  /** An abort touched it, so its text may legitimately be short. */
  disturbed: boolean;
  /** Audio chunks forwarded for it — zero means the caller heard nothing. */
  audioChunks: number;
  /** Its LLM stream reported a failure. */
  failed: boolean;
  done: boolean;
}

/** Mutable state the oracles and the generator share. */
export interface Monitor {
  current: ReplyRecord | null;
  stopped: boolean;
  /**
   * The session was reported DEAD to the client: an `onError` without
   * `fatal: false`. aai-ui answers that by calling `cleanupAudio()`, bumping the
   * connection generation and setting `running: false` — the microphone is
   * RELEASED and the call ends — so nothing conversational may follow it.
   */
  declaredDead: string | null;
  toolInFlight: number;
  /** Audio chunks forwarded in the whole session. */
  audioTotal: number;
  liveStreams: number;
  maxLiveStreams: number;
  consumedSteps: number;
  /**
   * This run has `preemptiveGeneration` on, which makes the EXACT-TEXT half of
   * {@link checkReplyIntegrity} unattributable — see the note there.
   */
  speculating: boolean;
  /**
   * TTS text chunks accounted to the last reply that COMPLETED CLEANLY, or
   * `null` when no such claim can be made — see the oracle at `onReplyStarted`.
   */
  ttsAccountedFor: number | null;
  flag: (what: string) => void;
  hit: (key: string) => void;
  /** Mark the in-flight reply as disturbed (an abort is about to touch it). */
  disturb: () => void;
}

/**
 * Assert an undisturbed turn spoke exactly the text the model produced.
 *
 * **Skipped entirely while `preemptiveGeneration` is on, deliberately.**
 * `expected` is accumulated per `doStream` CALL, which assumes one request per
 * reply consumed in turn order. A speculation breaks both halves: it consumes a
 * scripted step for a reply that may never exist, and an ADOPTED one is
 * generated before its reply starts, so the text cannot be attributed to a reply
 * at the moment it is served. Attributing it anyway is how a harness invents
 * findings — the failure mode this suite's module doc opens with — so the ON arm
 * declines to make the claim rather than guessing at it. Every other oracle
 * (guardrail 1, request validity, serialization, no-callback-after-stop,
 * audio-after-done, no-record-without-audio) runs unchanged in both arms, and
 * the adopted reply's TEXT is pinned deterministically instead, in
 * `transports/pipeline-preemption.test.ts`.
 */
export function checkReplyIntegrity(reply: ReplyRecord, tts: FakeTtsProvider, mon: Monitor): void {
  if (mon.speculating || reply.disturbed || reply.failed) return;
  const spoken = norm((tts.last()?.textChunks ?? []).slice(reply.ttsOffset).join(""));
  const expected = norm(reply.expected);
  if (spoken !== expected) {
    mon.flag(
      `reply ${reply.id} spoke ${JSON.stringify(spoken.slice(0, 80))} but the model produced ` +
        `${JSON.stringify(expected.slice(0, 80))}`,
    );
    return;
  }
  if (expected.length > 0) mon.hit("replyIntegrityChecked");
}

/** The greeting every run's session opens with, and the text its reply must speak. */
export const GREETING = "hello there friend";

/**
 * The CLIENT side of the run: every {@link TransportCallbacks} entry, wired to
 * the oracles and coverage counters. It lives here rather than in the spec
 * because it IS the model of what a client may observe — the same reason
 * {@link Monitor} and {@link checkReplyIntegrity} do.
 */
export function createCallbacks(mon: Monitor, tts: FakeTtsProvider): TransportCallbacks {
  const replyIds = new Set<string>();
  let started = 0;
  let doneCount = 0;
  const afterStop = (name: string): void => {
    if (mon.stopped) mon.flag(`${name} fired after stop() resolved`);
    // A fatal error frame is not a banner: the client has released the
    // microphone and ended the call (aai-ui's `handleErrorEvent`), so the session
    // going on to speak, listen or call tools means the two ends disagree about
    // whether it is alive. Only the paths that really terminate may report
    // fatally — in pipeline mode the provider open/error ones, which call
    // `terminate()`, never a turn-level LLM or TTS failure.
    if (mon.declaredDead !== null) {
      mon.flag(`${name} fired after a fatal [${mon.declaredDead}]`);
    }
  };
  return {
    onReplyStarted: (id: string) => {
      mon.hit("replyStarted");
      afterStop("onReplyStarted");
      if (replyIds.has(id)) mon.flag(`duplicate reply id ${id}`);
      replyIds.add(id);
      started++;
      // GUARDRAIL 1 as a property: after a reply COMPLETED cleanly, nothing may
      // synthesize text until the next reply starts. That gap is exactly the
      // window `isIdle()` lets a speculation run in, so one character reaching
      // TTS from a speculation lands here — as audible speech for a turn the
      // client was never told about.
      //
      // Only claimed after a CLEAN completion, and that restriction is the
      // finding this oracle's first draft produced against the flag-OFF arm: an
      // aborted turn's stream legitimately delivers a part or two after
      // `onCancelled`, so text reaching TTS in an ABORT's wake belongs to the
      // reply that was cut, not to whatever runs next. `onReplyDone` is the one
      // edge with no tail behind it — the TTS drain has already resolved.
      const chunks = tts.last()?.textChunks.length ?? 0;
      if (mon.ttsAccountedFor !== null && chunks > mon.ttsAccountedFor) {
        mon.flag(`TTS text was synthesized between a completed reply and ${id}`);
      }
      mon.ttsAccountedFor = null;
      mon.current = {
        id,
        ttsOffset: tts.last()?.textChunks.length ?? 0,
        expected: id.startsWith("pipeline-greeting") ? GREETING : "",
        disturbed: false,
        audioChunks: 0,
        failed: false,
        done: false,
      };
    },
    onReplyDone: () => {
      mon.hit("replyDone");
      afterStop("onReplyDone");
      doneCount++;
      if (doneCount > started) mon.flag("onReplyDone without a matching onReplyStarted");
      const reply = mon.current;
      if (reply === null) {
        mon.flag("onReplyDone with no reply in flight");
        return;
      }
      reply.done = true;
      mon.ttsAccountedFor = tts.last()?.textChunks.length ?? 0;
      checkReplyIntegrity(reply, tts, mon);
    },
    onCancelled: () => {
      mon.hit("cancelled");
      if (mon.toolInFlight > 0) mon.hit("cancelledWhileToolInFlight");
      mon.disturb();
      // An abort tail may still be in flight — no claim until the next clean
      // completion.
      mon.ttsAccountedFor = null;
      afterStop("onCancelled");
    },
    onAudioChunk: () => {
      afterStop("onAudioChunk");
      // The other half of guardrail 1: a speculation synthesises nothing, so
      // it can forward nothing.
      if (mon.current === null) mon.flag("audio chunk forwarded before any reply started");
      mon.audioTotal++;
      if (mon.current !== null) mon.current.audioChunks++;
      // session-core emits audio_done together with reply_done, so a chunk
      // after this reply's own replyDone is audio the client never plays — an
      // audibly clipped turn in a session that reports itself healthy.
      if (mon.current?.done === true) {
        mon.flag(`audio chunk after replyDone for ${mon.current.id}`);
      }
    },
    onAudioDone: noop,
    onUserTranscript: () => afterStop("onUserTranscript"),
    onUserTranscriptPartial: () => afterStop("onUserTranscriptPartial"),
    onAgentTranscript: () => afterStop("onAgentTranscript"),
    onAgentTranscriptPartial: () => afterStop("onAgentTranscriptPartial"),
    onToolCall: () => afterStop("onToolCall"),
    onToolCallDone: noop,
    onError: (code: string, _message: string, errOpts?: { fatal?: boolean }) => {
      mon.hit(`error:${code}`);
      if (errOpts?.fatal === false) mon.hit(`nonFatal:${code}`);
      else mon.declaredDead ??= code;
      const reply = mon.current;
      if (reply === null) return;
      if (code === "llm") reply.failed = true;
      if (code === "tts") reply.disturbed = true;
    },
    onSpeechStarted: () => afterStop("onSpeechStarted"),
    onSpeechStopped: noop,
    onSessionReady: noop,
  };
}

/**
 * Oracles + coverage over one outbound LLM request's messages. Hoisted out of
 * {@link instrumentLlm} to keep that function under the complexity cap.
 */
export function checkPrompt(prompt: readonly unknown[], mon: Monitor): void {
  // History records what the caller HEARD. In a session that forwarded no
  // audio at all, nothing was heard, so no interrupted reply may be recorded —
  // the oracle for the zero case, and the one a regression to "record what the
  // model generated" fails immediately.
  if (mon.audioTotal === 0 && JSON.stringify(prompt).includes("[interrupted]")) {
    mon.flag("an interrupted reply was recorded in a session that forwarded no audio");
  }
  if (prompt.some((m) => (m as PromptMsg).role === "tool")) mon.hit("llmRequestWithTool");
  // Past DEFAULT_MAX_HISTORY the cap trims on every push — the state the
  // orphan-tool-result oracle exists for.
  if (prompt.length >= 201) mon.hit("llmRequestAtHistoryCap");
}

/** Wrap the fake model so every request is validated and every stream tracked. */
export function instrumentLlm(
  llm: ReturnType<typeof createFakeLanguageModel>,
  stepText: readonly string[],
  mon: Monitor,
  refusals: readonly boolean[],
): void {
  const llmObj = llm as unknown as { doStream: (o: unknown) => Promise<unknown> };
  const rawDoStream = llmObj.doStream;
  let requests = 0;
  llmObj.doStream = async (o) => {
    const opts = o as { prompt?: unknown; abortSignal?: AbortSignal };
    mon.hit("llmRequest");
    // A request that never produces a stream at all. Reported by the catch in
    // `consumeLlmStream` rather than the stream-part handler — a separate
    // reporter, and the other half of what the fatality oracle checks: both end
    // the TURN, neither ends the session.
    if (refusals[requests++ % refusals.length] === true) {
      mon.hit("llmRefused");
      throw new Error("provider refused the connection");
    }
    if (Array.isArray(opts.prompt)) checkPrompt(opts.prompt, mon);
    for (const problem of promptProblems(opts.prompt)) mon.flag(`LLM request: ${problem}`);
    if (mon.current !== null) mon.current.expected += stepText[mon.consumedSteps] ?? "";
    mon.consumedSteps++;

    mon.liveStreams++;
    mon.maxLiveStreams = Math.max(mon.maxLiveStreams, mon.liveStreams);
    const result = (await rawDoStream.call(llm, o)) as { stream: ReadableStream<unknown> };
    const stream = trackStreamLifetime(result.stream, opts.abortSignal, () => {
      mon.liveStreams--;
    });
    return { ...result, stream };
  };
}
