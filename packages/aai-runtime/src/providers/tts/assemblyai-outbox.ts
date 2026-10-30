// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI streaming TTS adapter's OUTBOX: the reply text accepted but not
 * yet sent, and the rule for when the next `Generate`+`Flush` may go out.
 *
 * Split out for the same reason `assemblyai-turn.ts` and
 * `assemblyai-lifecycle.ts` are — the adapter owns the socket and the turn, this
 * owns one rule. The service paces a session on two budgets
 * (https://www.assemblyai.com/docs/tts/limits, "Pacing"), and going over
 * either closes it with `3010`:
 *
 * - **Control frames** — `Flush`, `Cancel`, `KeepAlive` share 20/s sustained.
 *   The token bucket is `assemblyai-control-budget.ts`.
 * - **Characters sent but not yet synthesized** — more than 8000 closes the
 *   session. A `FlushDone` is the service saying a flush's text has been
 *   synthesized, so the outbox counts the characters of every unacknowledged
 *   flush and holds the next one while it would take that over
 *   {@link MAX_UNSPOKEN_CHARS}. A single segment larger than the cap still goes
 *   out once nothing is outstanding, or it could never be sent.
 *
 * Whatever is held is not dropped: it stays buffered, the next send MERGES the
 * complete segments that accumulated meanwhile (one flush, one `FlushDone`),
 * and it is retried when the reason clears — the bucket refills (a timer), a
 * `FlushDone` arrives ({@link TtsOutbox.onAck}), or a replacement socket opens
 * ({@link TtsOutbox.socketReady}). New text never overtakes a held backlog.
 *
 * A pacing recovery goes through the same door ({@link TtsOutbox.requeue}), so
 * the text a dropped socket owed reaches its replacement at a rate the service
 * accepts, rather than as the burst that tripped the limit.
 */

import { CONTROL_FRAME_RESERVE, type ControlBudget } from "./assemblyai-control-budget.ts";
import { endsAtSentence, splitSegment } from "./assemblyai-segment.ts";

/**
 * The most characters the outbox lets be sent and unacknowledged at once —
 * half the service's documented 8000, for the same reason the control budget
 * runs at half rate. ~40 s of speech, so a voice reply never waits on it.
 */
export const MAX_UNSPOKEN_CHARS = 4000;

/** What the outbox needs from the adapter. */
export interface TtsOutboxEffects {
  /** The control-frame budget, shared with `Cancel` and `KeepAlive`. */
  budget: ControlBudget;
  /**
   * Can a flush go to a live socket now? False while a replacement socket is
   * connecting: the backlog waits for {@link TtsOutbox.socketReady}.
   */
  canSend(): boolean;
  /** Send `text` as `Generate` frame(s) + `Flush`; `false` when refused. */
  sendFlush(text: string): boolean;
  /** Every accepted text has been sent: let the turn end. */
  closeTurn(): void;
}

/** One session's outbox. */
export interface TtsOutbox {
  /** A new reply: its first flush may spend the control budget's reserve. */
  beginTurn(): void;
  /** Accept reply text; sends what the budgets allow. */
  push(text: string): void;
  /**
   * The reply has no more text: send the remainder, then close the turn — at
   * once, or when a held backlog has gone out.
   */
  close(): void;
  /** A `FlushDone`: the oldest flush's characters are synthesized. */
  onAck(): void;
  /** A replacement socket opened: send what waited for it. */
  socketReady(): void;
  /** Forget everything — the turn ended or was cancelled. */
  clear(): void;
  /**
   * The socket was dropped: return the text of every flush it still owed,
   * oldest first, and forget them (their acknowledgements will never come).
   */
  takeOwed(): string[];
  /**
   * Put text a dropped socket owed back at the FRONT of the backlog, to be
   * sent through the same budgets as anything else once the replacement
   * opens ({@link socketReady}). `closed` re-closes the turn once it has gone
   * out (the pipeline closed it before the drop).
   */
  requeue(text: string, closed: boolean): void;
}

/** Create a {@link TtsOutbox}. */
export function createTtsOutbox(fx: TtsOutboxEffects): TtsOutbox {
  let buffered = "";
  // `close()` ran: send the remainder too, then close the turn.
  let closePending = false;
  let firstFlushOfTurn = false;
  // Text of each flush sent and not yet acknowledged, oldest first.
  let unacked: string[] = [];
  let unspoken = 0;
  // Why the backlog is held, when it is not the budget timer.
  let hold: "ack" | "socket" | undefined;
  let pumpTimer: ReturnType<typeof setTimeout> | undefined;

  const held = (): boolean => hold !== undefined || pumpTimer !== undefined;
  const floor = (): number => (firstFlushOfTurn ? 0 : CONTROL_FRAME_RESERVE);

  /**
   * The largest leading segment that fits in `room`: every complete segment
   * buffered (`splitSegment` already merges them), or, when that is too
   * long, the same cut at the last sentence end inside `room`. With flushes
   * outstanding, a cut that would land mid-sentence is refused — the caller
   * holds for acknowledgements instead, since a mid-sentence seam is audible;
   * with nothing outstanding it is taken, as any long run without a sentence
   * end is (`assemblyai-segment.ts`).
   */
  const fitHead = (room: number): string => {
    const whole = splitSegment(buffered)?.head ?? "";
    if (whole.length <= room) return whole;
    const cut = splitSegment(buffered.slice(0, room))?.head;
    if (cut !== undefined && (unspoken === 0 || endsAtSentence(cut))) return cut;
    return whole;
  };

  /**
   * The next text to flush, or `undefined` when nothing is ready: the
   * {@link fitHead}, plus the remainder once the reply is closed and it all
   * fits. Only when nothing fits is the head larger than the room —
   * {@link overCap} then holds it.
   */
  const nextHead = (): string | undefined => {
    const room = Math.max(MAX_UNSPOKEN_CHARS - unspoken, 0);
    const head = fitHead(room);
    const rest = buffered.length - head.length;
    if (closePending && rest > 0 && (head.length === 0 || buffered.length <= room)) {
      return buffered;
    }
    return head.length > 0 ? head : undefined;
  };

  const finishClose = (): void => {
    closePending = false;
    buffered = "";
    fx.closeTurn();
  };

  /** Would `head` take the unsynthesized characters over the cap? */
  const overCap = (head: string): boolean =>
    unspoken > 0 && unspoken + head.length > MAX_UNSPOKEN_CHARS;

  /**
   * May `head` go out now? If not, record why and arrange the retry — a
   * spent control budget is a timer; the other two wait to be told.
   */
  const admit = (head: string): boolean => {
    if (!fx.canSend()) {
      hold = "socket";
      return false;
    }
    if (overCap(head)) {
      hold = "ack";
      return false;
    }
    if (!fx.budget.tryTake(floor())) {
      schedulePump();
      return false;
    }
    return true;
  };

  /** Send `head` off the front of the backlog; `false` when it was refused. */
  const sendHead = (head: string): boolean => {
    buffered = buffered.slice(head.length);
    if (!fx.sendFlush(head)) {
      // As the unbudgeted adapter did: a refused end-of-turn flush still
      // closes the turn, or the pipeline's flush-wait would hang.
      if (closePending) finishClose();
      return false;
    }
    firstFlushOfTurn = false;
    unacked.push(head);
    unspoken += head.length;
    return true;
  };

  /** Send what every budget allows, holding the rest with the reason it waits. */
  const drain = (): void => {
    hold = undefined;
    for (let head = nextHead(); head !== undefined; head = nextHead()) {
      if (!(admit(head) && sendHead(head))) return;
    }
    if (closePending && buffered.length === 0) finishClose();
  };

  function schedulePump(): void {
    if (pumpTimer !== undefined) return;
    pumpTimer = setTimeout(
      () => {
        pumpTimer = undefined;
        // Everything that accumulated while the budget refilled, merged.
        drain();
      },
      Math.max(1, fx.budget.msUntil(floor())),
    );
    pumpTimer.unref?.();
  }

  return {
    beginTurn() {
      firstFlushOfTurn = true;
    },
    push(text) {
      buffered += text;
      if (!held()) drain();
    },
    close() {
      closePending = true;
      if (!held()) drain();
    },
    onAck() {
      unspoken -= unacked.shift()?.length ?? 0;
      if (hold === "ack") drain();
    },
    socketReady() {
      if (hold === "socket") drain();
    },
    clear() {
      clearTimeout(pumpTimer);
      pumpTimer = undefined;
      hold = undefined;
      closePending = false;
      buffered = "";
      unacked = [];
      unspoken = 0;
    },
    takeOwed() {
      const owed = unacked;
      unacked = [];
      unspoken = 0;
      // What waited on those acks now waits for the replacement instead.
      if (hold === "ack") hold = "socket";
      return owed;
    },
    requeue(text, closed) {
      buffered = text + buffered;
      if (closed) closePending = true;
      // Called while the replacement is still being built, so nothing can go
      // out yet: everything waits for `socketReady`.
      clearTimeout(pumpTimer);
      pumpTimer = undefined;
      hold = "socket";
    },
  };
}
