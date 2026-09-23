// Copyright 2026 the AAI authors. MIT license.
/**
 * What the caller actually HEARD of the reply in progress — one cursor, one
 * owner.
 *
 * Three things used to guess independently how far a reply got: the playback
 * clock (session-scoped, graced, boolean "still audible"), the reply-tail
 * tracker's character-proportional cut for the resume anchor, and the history
 * writer, which made no estimate at all and recorded what the model GENERATED.
 * The last two are collapsed here so they cannot disagree: if truncation used
 * word timings while the resume prompt kept a proportional cut, the prompt
 * would quote an anchor history says was never spoken. History truncation and
 * the resume anchor are now two readers of ONE answer.
 *
 * **The two biases are opposite, and that asymmetry is the thing to preserve.**
 *
 * | reader | question | grace | errs |
 * | --- | --- | --- | --- |
 * | {@link HeardTracker.pending} | could anything still be audible? | + `PIPELINE_PLAYBACK_GRACE_MS` | LATE |
 * | {@link HeardTracker.heard} | where had the voice actually got to? | − {@link HEARD_AUDIO_LAG_MS} | EARLY |
 *
 * `pending()` errs late because a spurious barge-in cancel is harmless (the
 * client flushes an already-empty buffer) while a missed one lets the agent
 * talk over the caller. The heard cursor errs early because over-keeping is the
 * measured failure — the model believes it delivered information the caller
 * never got, which is the repetition finding on `buildTailResumePrompt` — while
 * under-keeping costs at most a word or two of redundancy, which the resume
 * prompt's "without repeating what they already heard" absorbs. A future
 * unification of the two would get exactly this wrong; same shape as the note
 * in `pipeline-turn-outcome.ts`.
 *
 * **The estimate's own bias was the first thing to get this wrong**, and it is
 * worth knowing before touching `heardChars`: dividing the text handed to TTS
 * by the audio that came back reads as a speech rate and is not one, because
 * the two cover different amounts of the reply. See
 * {@link MAX_SPEECH_CHARS_PER_MS}.
 *
 * **The clock inside (`pipeline-playback-clock.ts`) is SESSION-scoped, the
 * rest is REPLY-scoped.**
 * `startReply()` deliberately does not touch it: it tracks audio the client is
 * still playing out, which outlives the server-side turn that produced it (that
 * is the whole reason it exists). Only `cut()` — a barge-in, a cancel, a reset,
 * all of which end with the client flushing its playback buffer — restarts it.
 */

import { HEARD_AUDIO_LAG_MS } from "@alexkroman1/aai/internal";
import type { TtsWordTiming } from "../providers/openers.ts";
import { alignedEnd, alignWords, lastHeardWord, snapToWord } from "./pipeline-heard-words.ts";
import { createPlaybackClock } from "./pipeline-playback-clock.ts";
import { buildTailResumePrompt, tailResumeWorthRunning } from "./pipeline-recovery.ts";

/**
 * Ceiling on how fast synthesized speech can deliver characters, in characters
 * per millisecond of audio.
 *
 * `spoken.length / audioMs` is NOT a speech rate, and treating it as one is
 * what this constant exists to stop. `spoken` is every character handed to the
 * TTS provider; `audioMs` is only the audio that has come BACK, i.e. the prefix
 * already synthesized. Text runs ahead of synthesis by however far the LLM is
 * ahead of the voice, so the ratio is inflated by exactly that gap — widest
 * mid-reply, which is when a barge-in happens — and the estimate then reads
 * text nobody has spoken yet as heard. Worked through: an LLM streaming ~200
 * chars/s against a provider synthesizing at 1x hands over a 300-character
 * reply inside 1.5s, so five seconds in the ratio claims all 300 characters
 * against the ~75 the caller has actually heard.
 *
 * No causal bound fixes that. "Characters submitted before this audio position
 * arrived" is sound and useless here: the gap is PROPORTIONAL rather than
 * additive, so in steady state that watermark carries the same inflation. The
 * rate has to come from the audio, and absent word timings the only thing that
 * knows it is the language — English narration runs 150–190 words per minute at
 * ~5.7 characters per word including the space, i.e. 14–18 characters a second.
 *
 * So the ceiling sits at the top of that band and the estimate takes the MIN of
 * it and the observed ratio: a voice slower than the ceiling is still tracked
 * by its own audio (which is the exact answer once a reply is fully
 * synthesized), and only a ratio no real voice could produce is clamped. What
 * is left over-counts by at most the width of the band — an absolute
 * {@link HEARD_AUDIO_LAG_MS} of ear-lag is subtracted on top, which is ~12
 * characters at this rate and covers that residual for any prefix worth
 * recording.
 */
const MAX_SPEECH_CHARS_PER_MS = 18 / 1000;

/** Where the caller's ear had got to when the reply was cut. */
export interface HeardPosition {
  /** Characters of the TTS text (filler included) the caller had heard. */
  chars: number;
  /**
   * Characters of the RECORDABLE text inside that prefix — the model's own
   * words, with dead-air filler excluded. This indexes the turn's `accumulated`
   * string, so `accumulated.slice(0, recordableChars)` is a real prefix.
   */
  recordableChars: number;
  /** `accumulated.slice(0, recordableChars)`, i.e. the model text they heard. */
  text: string;
}

/**
 * Per-reply record of what reached TTS and what of it the caller heard.
 *
 * Writers are the transport's provider handlers; readers are the barge-in gate
 * (`pending`), history truncation (`heard`) and false-interruption recovery
 * (`resumePrompt`).
 */
export interface HeardTracker {
  /**
   * Text handed to TTS for the current reply; returns the cumulative TTS
   * transcript (what the interim caption publishes). `record: false` marks
   * dead-air filler — audible, so it counts toward the heard POSITION, but not
   * part of the model's text, so it never counts toward what history records.
   */
  onText(text: string, record: boolean): string;
  /** One forwarded PCM16 chunk of the current reply's TTS audio. */
  onAudio(pcm: Int16Array): void;
  /**
   * The client's report of how much forwarded audio it still holds unplayed
   * (`playback_progress`). Corrects the open-loop estimate every reader here
   * depends on — see `PlaybackClock.onClientReport` for why it may only
   * ever move the clock later.
   */
  onClientPlaybackReport(bufferedMs: number): void;
  /** Word timings for this reply's audio, already rebased by the adapter. */
  onWords(words: readonly TtsWordTiming[]): void;
  /**
   * A new reply started. Resets the per-reply text, spans, words and latch —
   * but NOT the playback clock, which is session-scoped (see the module doc).
   *
   * A PERSISTED reply whose audio is still queued client-side is not
   * forgotten: it is kept, with its own position on the clock, so a cut that
   * lands during the NEXT reply can still take back what it never played —
   * see {@link markPersisted}.
   */
  startReply(): void;
  /**
   * The current reply's full text is now in history; `onCut` takes back what
   * the caller had not heard, and is called at most once, by {@link cut}, with
   * this reply's heard position — only if some of its audio was still unplayed
   * at that moment. A reply that played out in full is never touched.
   *
   * This is what reaches the cuts `persistBargeIn` cannot: that path only runs
   * when the turn BODY is aborted, and a measured 35 of 36 barge-ins landed
   * after the body had committed the whole reply — during the TTS drain, or in
   * the client's playback tail, which can hold 8-15s. See
   * `pipeline-heard-history.ts`.
   *
   * Called after the reply was already cut (the body persisted past an abort),
   * it runs `onCut` at once with the latched position.
   */
  markPersisted(onCut: (heard: HeardPosition) => void): void;
  /**
   * Has this reply sent any RECORDABLE text — real speech rather than filler?
   *
   * Barge-in gates on "is the agent speaking", and dead-air cover made that
   * true without the agent having said anything: the filler is audio, so it
   * drives the playback clock and `turns.markSpoke()` alike. A caller talking
   * over a holding phrase was therefore treated as interrupting a reply, and
   * the abort discarded the real reply being generated behind it. Measured on
   * a 114-task tau2-bench retail run: 435 barge-ins and **75 aborted turns
   * discarding 553s of completed work** — 48 losing more than 5s each, worst
   * 40.6s — with calls ending in the caller hanging up on an agent that was,
   * from its own side, still working.
   *
   * `spans` carries the flag per send and `startReply()` already clears it, so
   * this reads state the tracker keeps anyway.
   */
  spokeRecordable(): boolean;
  /** True while the client may still be playing already-forwarded audio. */
  pending(): boolean;
  /** Ms until {@link pending} turns false — see `PlaybackClock.playoutMs`. */
  playoutMs(): number;
  /**
   * The reply is being cut right now: LATCH the heard position, then restart
   * the playback clock (every abort path ends with the client flushing its
   * buffer).
   *
   * The latch is what makes the readers order-independent. `persistBargeIn`
   * runs when the aborted stream settles, which is necessarily AFTER the abort
   * reset the clock — reading the position then would report every interrupted
   * reply as fully heard, which is exactly the bug this module exists to fix.
   *
   * Then every persisted reply with audio still unplayed — this one and any
   * earlier one still queued ahead of it — has its `markPersisted` callback
   * run, AFTER the clock reset, since the client is flushing all of it.
   */
  cut(): void;
  /** The heard position — the latched one once {@link cut} has run. */
  heard(): HeardPosition;
  /**
   * Cut-point resume prompt for a barge-in on this reply, or `undefined` when
   * the caller had heard essentially all of it (then a resume turn would only
   * append a fragment to a reply that already landed).
   */
  resumePrompt(): string | undefined;
}

/**
 * One reply's TTS record — everything {@link HeardTracker.startReply} starts
 * afresh.
 */
interface ReplyRecord {
  spoken: string;
  /**
   * One entry per TTS send, in order: how many characters it carried and
   * whether they belong in the record. Filler must not ride into history even
   * though it is audible — see `emitText` in pipeline-stream-parts.ts for the
   * measured reason.
   */
  spans: { len: number; record: boolean }[];
  audioMs: number;
  words: TtsWordTiming[];
  /**
   * The session's forwarded-audio total when this reply's latest chunk went
   * out. Everything forwarded since is queued BEHIND this reply client-side,
   * which is how an earlier reply's share of the clock's backlog is read.
   */
  forwardedAtEnd: number;
  /** Set once the reply is in history — see {@link HeardTracker.markPersisted}. */
  onCut: ((heard: HeardPosition) => void) | undefined;
}

/**
 * Most earlier replies kept for a cut. One is the realistic case — a chained
 * turn starting while the previous reply plays out — and a reply only stays
 * while its audio is still queued, so this bounds memory, not behaviour.
 */
const MAX_PLAYING_REPLIES = 4;

function newReply(forwardedMs: number): ReplyRecord {
  return {
    spoken: "",
    spans: [],
    audioMs: 0,
    words: [],
    forwardedAtEnd: forwardedMs,
    onCut: undefined,
  };
}

/**
 * Characters of `reply.spoken` heard by `ms`.
 *
 * With word timings, the last word whose audio has WHOLLY elapsed (`endMs`,
 * not `startMs` — a half-spoken word was not heard). Beyond the last reported
 * word the timeline says nothing, so the proportional estimate takes over,
 * floored at what the words already established.
 */
function heardChars(reply: ReplyRecord, ms: number): number {
  const { spoken, audioMs, words } = reply;
  if (audioMs <= 0) return 0;
  // The MIN is the correction — see MAX_SPEECH_CHARS_PER_MS. `spoken.length /
  // audioMs` is the rate at which text was handed over, not the rate at which
  // it is spoken, and the two differ by however much of the reply has not
  // been synthesized yet.
  const charsPerMs = Math.min(spoken.length / audioMs, MAX_SPEECH_CHARS_PER_MS);
  const proportional = snapToWord(spoken, Math.round(charsPerMs * ms));
  if (words.length === 0) return proportional;
  const last = lastHeardWord(words, ms);
  if (last < 0) return 0;
  const end = alignedEnd(alignWords(spoken, words), last);
  // Every heard word failed to align: degrade to the estimate rather than
  // claiming nothing was heard.
  if (end < 0) return proportional;
  return last === words.length - 1 ? Math.max(end, proportional) : end;
}

/**
 * The recordable text inside the first `chars` characters of `reply.spoken`,
 * and its length.
 *
 * One walk, not two: the count is `text.length` by construction — the record
 * is a concatenation of whole slices — so computing them separately was the
 * same span walk written twice, run twice per read, with two chances to
 * disagree about which characters a partially-heard span contributes.
 */
function recordable(reply: ReplyRecord, chars: number): { text: string; length: number } {
  let seen = 0;
  let text = "";
  for (const span of reply.spans) {
    if (seen >= chars) break;
    if (span.record) text += reply.spoken.slice(seen, seen + Math.min(span.len, chars - seen));
    seen += span.len;
  }
  return { text, length: text.length };
}

/** Create a {@link HeardTracker}. */
export function createHeardTracker(opts: {
  /** Sample rate of the forwarded PCM16 (Hz), to convert chunks to duration. */
  sampleRate: number;
  /** Ear-lag subtracted from the playback position; defaults to HEARD_AUDIO_LAG_MS. */
  lagMs?: number | undefined;
  /** Clock source; injectable so unit tests need no fake timers. */
  now?: (() => number) | undefined;
}): HeardTracker {
  const lagMs = opts.lagMs ?? HEARD_AUDIO_LAG_MS;
  const now = opts.now ?? Date.now;
  const clock = createPlaybackClock(opts.sampleRate, now);

  // SESSION-scoped: every ms of audio ever forwarded, the ruler the earlier
  // replies below are placed on.
  let forwardedMs = 0;
  // REPLY-scoped, started afresh by startReply().
  let current = newReply(forwardedMs);
  let latched: (HeardPosition & { unheardMs: number }) | null = null;
  // Earlier PERSISTED replies whose audio may still be queued ahead of the
  // current one, oldest first — the cut targets `startReply` used to wipe.
  let playing: ReplyRecord[] = [];

  /**
   * Ms of `reply`'s audio the client has not played yet. The clock's backlog
   * is FIFO, so whatever was forwarded after this reply sits behind it; the
   * reply's own share is what is left once that is subtracted. For the current
   * reply nothing is behind it and this is the clock's backlog, capped.
   */
  function unplayedMs(reply: ReplyRecord): number {
    const behind = forwardedMs - reply.forwardedAtEnd;
    return Math.min(reply.audioMs, Math.max(0, clock.remainingMs() - behind));
  }

  function position(reply: ReplyRecord): HeardPosition & { unheardMs: number } {
    const heardMs = Math.max(0, reply.audioMs - unplayedMs(reply) - lagMs);
    const chars = heardChars(reply, heardMs);
    const record = recordable(reply, chars);
    return {
      chars,
      recordableChars: record.length,
      text: record.text,
      unheardMs: clock.remainingMs(),
    };
  }

  const publicPosition = (at: HeardPosition): HeardPosition => ({
    chars: at.chars,
    recordableChars: at.recordableChars,
    text: at.text,
  });

  /**
   * Replies a cut right now takes something back from, each with its heard
   * position — read BEFORE the clock reset, like the latch.
   */
  function cutTargets(): { onCut: (heard: HeardPosition) => void; at: HeardPosition }[] {
    const targets: { onCut: (heard: HeardPosition) => void; at: HeardPosition }[] = [];
    for (const reply of [...playing, current]) {
      const { onCut } = reply;
      reply.onCut = undefined;
      if (onCut === undefined || unplayedMs(reply) <= 0) continue;
      targets.push({ onCut, at: position(reply) });
    }
    return targets;
  }

  return {
    onText(text: string, record: boolean): string {
      current.spans.push({ len: text.length, record });
      current.spoken += text;
      return current.spoken;
    },
    onAudio(pcm: Int16Array): void {
      const chunkMs = (pcm.length / opts.sampleRate) * 1000;
      current.audioMs += chunkMs;
      forwardedMs += chunkMs;
      current.forwardedAtEnd = forwardedMs;
      clock.onChunk(pcm);
    },
    onClientPlaybackReport(bufferedMs: number): void {
      // Only the CLOCK moves. `audioMs` is how much audio this reply produced,
      // which the client cannot tell us anything about — conflating the two
      // would let a report inflate the reply's own length and push the heard
      // cursor past text that was never synthesized.
      clock.onClientReport(bufferedMs);
    },
    onWords(incoming: readonly TtsWordTiming[]): void {
      current.words.push(...incoming);
    },
    spokeRecordable(): boolean {
      return current.spans.some((span) => span.record);
    },
    startReply(): void {
      if (current.onCut !== undefined) playing.push(current);
      playing = playing.filter((reply) => unplayedMs(reply) > 0).slice(-MAX_PLAYING_REPLIES);
      current = newReply(forwardedMs);
      latched = null;
    },
    markPersisted(onCut: (heard: HeardPosition) => void): void {
      if (latched !== null) {
        onCut(publicPosition(latched));
        return;
      }
      current.onCut = onCut;
    },
    pending: clock.pending,
    playoutMs: clock.playoutMs,
    cut(): void {
      // Latch once per reply: the first cut resets the clock, so a repeat
      // would read nothing left to play and latch the whole reply as heard.
      latched ??= position(current);
      const targets = cutTargets();
      clock.reset();
      // The client is flushing everything it holds, so nothing earlier is
      // still playing to be cut again.
      playing = [];
      for (const { onCut, at } of targets) onCut(publicPosition(at));
    },
    heard(): HeardPosition {
      return publicPosition(latched ?? position(current));
    },
    resumePrompt(): string | undefined {
      const at = latched ?? position(current);
      if (!tailResumeWorthRunning(current.audioMs, at.unheardMs)) return;
      // The anchor is the RECORDABLE heard text, which is character-identical
      // to what history records for this reply — so the prompt can never quote
      // words the record denies, and never quotes filler.
      return buildTailResumePrompt(at.text);
    },
  };
}
