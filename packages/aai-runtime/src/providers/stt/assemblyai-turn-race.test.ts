// Copyright 2026 the AAI authors. MIT license.
/**
 * Property test: the AssemblyAI adapter's turn commit racing `forceEndOfTurn`,
 * the formatted-final pairing, a far-end close or error, `close()` (whose SDK
 * half still drains the socket) and the session's abort.
 *
 * `assemblyai.test.ts` pins one ordering per case. Here a fake SERVER sits
 * behind the `createTranscriber` seam and `fc.scheduler` decides when each
 * `Turn` message is produced and when it is delivered, while a generated client
 * sends audio, forces end-of-turn, moves the endpointing floor, closes, aborts,
 * and has the far end close or error. Messages arrive in order, as one socket
 * delivers them — the one thing the scheduler may NOT reorder. A forced end
 * drops the turn's remaining partials and ends it at once, as `ForceEndpoint`
 * does; what is already on the wire still lands.
 *
 * Both commit shapes run: `universal-streaming-english` with `formatTurns`
 * (two `end_of_turn` messages per turn, the unformatted one demoted to a
 * partial — `_assemblyai-turn.ts`) and the default Universal-3.5 Pro (one,
 * already formatted). The oracles are `SttEvents`' contract (`../openers.ts`):
 *
 * - **one commit per turn, in order, with the committing text**: no turn
 *   commits twice, finals arrive in `turn_order`, and the text is the
 *   formatted transcript wherever one was asked for;
 * - **no stale event**: no partial of a turn after that turn (or a later one)
 *   committed — it would land in the next turn's caption;
 * - **liveness**: every turn whose end the adapter received while open
 *   commits;
 * - **nothing after close**: no event once `close()` was called, though the
 *   fake SDK's close keeps delivering what was on the wire (the real one waits
 *   for `Termination`); no wire call after close; one teardown.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { flush } from "../../_timing-test-utils.ts";
import { FakeTranscriber } from "./_assemblyai-test-utils.ts";
import {
  type AssemblyAISession,
  type CreateAssemblyAITranscriber,
  openAssemblyAI,
} from "./assemblyai.ts";

type Mode = "formatted-pair" | "single-final";

type ActionKind =
  | "audio"
  | "forceEnd"
  | "endpointing"
  | "close"
  | "abort"
  | "serverClose"
  | "serverError";

const actionArb: fc.Arbitrary<ActionKind> = fc.oneof(
  { weight: 4, arbitrary: fc.constant("audio" as const) },
  { weight: 3, arbitrary: fc.constant("forceEnd" as const) },
  { weight: 2, arbitrary: fc.constant("endpointing" as const) },
  { weight: 1, arbitrary: fc.constant("close" as const) },
  { weight: 1, arbitrary: fc.constant("abort" as const) },
  { weight: 1, arbitrary: fc.constant("serverClose" as const) },
  { weight: 1, arbitrary: fc.constant("serverError" as const) },
);

/** One scripted turn: how many partials precede its end, and an empty lead-in. */
type TurnScript = { partials: number; emptyLead: boolean };

const turnArb: fc.Arbitrary<TurnScript> = fc.record({
  partials: fc.integer({ min: 0, max: 3 }),
  emptyLead: fc.boolean(),
});

const cov = {
  runs: 0,
  /** A forced end cut a turn's remaining partials. */
  forcedCuts: 0,
  /** A formatted turn committed after its unformatted end was demoted. */
  pairedCommits: 0,
  /** A Turn message reached the SDK half after `close()` — what the closed latch is for. */
  turnsAfterClose: 0,
  /** A far-end close or error with the session still open. */
  farEndFailures: 0,
  turnsCommitted: 0,
};

type TurnMsg = {
  turn_order: number;
  transcript: string;
  end_of_turn: boolean;
  turn_is_formatted: boolean;
  words: { start: number; end: number; confidence: number }[];
};

/** The far end, behind the fake transcriber. */
type Far = {
  s: fc.Scheduler;
  mode: Mode;
  fake: FakeTranscriber | null;
  /** Synthesized but not yet sent — what a ForceEndpoint can still cut. */
  synth: TurnMsg[];
  /** On the wire, in order. */
  wire: TurnMsg[];
  /** Turns whose first partial the server already sent. */
  started: Set<number>;
  /** Has the SDK's socket gone away? Nothing is delivered after. */
  dead: boolean;
};

const word = { start: 0, end: 10, confidence: 0.9 };

function turnMessages(mode: Mode, order: number, t: TurnScript): TurnMsg[] {
  const msgs: TurnMsg[] = [];
  const base = { turn_order: order, words: [word] };
  if (t.emptyLead) {
    msgs.push({ ...base, transcript: "", end_of_turn: false, turn_is_formatted: false, words: [] });
  }
  for (let i = 1; i <= t.partials; i++) {
    msgs.push({
      ...base,
      transcript: `p${order}.${i}`,
      end_of_turn: false,
      turn_is_formatted: false,
    });
  }
  if (mode === "formatted-pair") {
    msgs.push({ ...base, transcript: `u${order}`, end_of_turn: true, turn_is_formatted: false });
  }
  msgs.push({ ...base, transcript: `F${order}`, end_of_turn: true, turn_is_formatted: true });
  return msgs;
}

function isEnd(msg: TurnMsg): boolean {
  return msg.end_of_turn;
}

/** The client's model and the oracles over what the session emits. */
type Near = {
  violations: string[];
  session: AssemblyAISession;
  far: Far;
  controller: AbortController;
  /** `close()` has been called, directly or by the abort. */
  closing: boolean;
  /** The pending `close()` the client started, if any. */
  closed: Promise<void> | null;
  errorsAllowed: boolean;
  /** Turns whose committing message the adapter received while open. */
  owed: Set<number>;
  committed: Map<number, number>;
  lastCommitted: number;
  /** Wire calls the adapter made on the transcriber after close. */
  wireAfterClose: number;
};

const flag = (near: Near, what: string): void => {
  near.violations.push(what);
};

function turnOf(text: string): number {
  return Number(/\d+/.exec(text)?.[0] ?? -1);
}

function deliver(near: Near): void {
  const far = near.far;
  const msg = far.wire.shift();
  if (msg === undefined || far.dead || far.fake === null) return;
  if (near.closing) cov.turnsAfterClose++;
  else if (isEnd(msg) && msg.turn_is_formatted) near.owed.add(msg.turn_order);
  far.fake.emit("turn", msg);
}

function produce(near: Near): void {
  const far = near.far;
  const msg = far.synth.shift();
  if (msg === undefined) return;
  if (!isEnd(msg)) far.started.add(msg.turn_order);
  far.wire.push(msg);
  void far.s.schedule(Promise.resolve(), "deliver").then(() => deliver(near));
}

/** `ForceEndpoint` as the service treats it: the turn being built ends now. */
function receiveForceEndpoint(far: Far): void {
  const head = far.synth[0];
  if (head === undefined || !far.started.has(head.turn_order)) return;
  const before = far.synth.length;
  far.synth = far.synth.filter((m) => m.turn_order !== head.turn_order || isEnd(m));
  if (far.synth.length < before) cov.forcedCuts++;
}

function transcribersFor(far: Far, near: () => Near | undefined): CreateAssemblyAITranscriber {
  return (_apiKey, params) => {
    const fake = new FakeTranscriber(params);
    far.fake = fake;
    const afterClose = (): void => {
      const n = near();
      if (n?.closing) n.wireAfterClose++;
    };
    fake.forceEndpoint.mockImplementation(() => {
      afterClose();
      void far.s.schedule(Promise.resolve(), "receive").then(() => receiveForceEndpoint(far));
    });
    fake.updateConfiguration.mockImplementation(afterClose);
    fake.sendAudio.mockImplementation(() => {
      // The tail `closeAfterFlush` sends ahead of the close is not "after".
      const n = near();
      if (n?.closing && fake.close.mock.calls.length > 0) n.wireAfterClose++;
    });
    // The SDK's close waits for `Termination`: what is on the wire still
    // arrives, then the socket closes cleanly.
    fake.close.mockImplementation(async () => {
      await far.s.schedule(Promise.resolve(), "termination");
      while (far.wire.length > 0) deliver(near() as Near);
      far.dead = true;
      fake.emit("close", 1000, "");
    });
    return fake;
  };
}

function onFinal(near: Near, text: string): void {
  if (near.closing) flag(near, `final ${text} after close()`);
  const t = turnOf(text);
  const n = (near.committed.get(t) ?? 0) + 1;
  near.committed.set(t, n);
  if (n > 1) flag(near, `turn ${t} committed ${n} times`);
  if (t <= near.lastCommitted && n === 1) {
    flag(near, `turn ${t} committed after turn ${near.lastCommitted}`);
  }
  if (!text.startsWith("F"))
    flag(near, `turn ${t} committed ${JSON.stringify(text)}, not its formatted text`);
  if (near.far.mode === "formatted-pair") cov.pairedCommits++;
  near.lastCommitted = Math.max(near.lastCommitted, t);
  cov.turnsCommitted++;
}

function onPartial(near: Near, text: string): void {
  if (near.closing) flag(near, `partial ${text} after close()`);
  const t = turnOf(text);
  if (t <= near.lastCommitted) {
    flag(
      near,
      `partial ${JSON.stringify(text)} of turn ${t} after turn ${near.lastCommitted} committed`,
    );
  }
}

/**
 * Start `close()` without awaiting it: the SDK half waits on a scheduled
 * `termination`, and a sequence step that awaited it would hold the scheduler.
 */
function beginClose(near: Near): Promise<void> {
  near.closing = true;
  near.closed = near.session.close();
  return near.closed;
}

let floorSeq = 0;

const ACTIONS: Record<ActionKind, (near: Near) => void> = {
  audio(near) {
    // 60 ms at 16 kHz: over the 50 ms frame floor, so a close-time tail flushes.
    near.session.sendAudio(new Int16Array(960));
  },
  forceEnd(near) {
    near.session.forceEndOfTurn?.();
  },
  endpointing(near) {
    near.session.updateEndpointing?.(100 + (++floorSeq % 5) * 50);
  },
  close(near) {
    void beginClose(near);
  },
  abort(near) {
    if (near.controller.signal.aborted) return;
    // `closeOnAbort` closes on a microtask; the oracle treats the session as
    // closing once that close reaches the transcriber (the wrapper in openNear).
    near.controller.abort();
  },
  serverClose(near) {
    const far = near.far;
    if (far.dead || far.fake === null) return;
    if (!near.closing) cov.farEndFailures++;
    near.errorsAllowed = true;
    far.dead = true;
    far.fake.emit("close", 1006, "abnormal");
  },
  serverError(near) {
    const far = near.far;
    if (far.dead || far.fake === null) return;
    if (!near.closing) cov.farEndFailures++;
    near.errorsAllowed = true;
    far.fake.emit("error", new Error("far end failed"));
  },
};

async function openNear(far: Far, script: readonly TurnScript[]): Promise<Near> {
  let near: Near | undefined;
  const controller = new AbortController();
  const opts =
    far.mode === "formatted-pair"
      ? { model: "universal-streaming-english", formatTurns: true }
      : {};
  const session = (await openAssemblyAI(
    opts,
    transcribersFor(far, () => near),
  ).open({
    sampleRate: 16_000,
    apiKey: "k",
    signal: controller.signal,
  })) as AssemblyAISession;
  const created: Near = {
    violations: [],
    session,
    far,
    controller,
    closing: false,
    closed: null,
    errorsAllowed: false,
    owed: new Set(),
    committed: new Map(),
    lastCommitted: 0,
    wireAfterClose: 0,
  };
  near = created;
  // The abort's close runs through the shell; observe it at the transcriber.
  const fake = far.fake as FakeTranscriber;
  const sdkClose = fake.close.getMockImplementation();
  fake.close.mockImplementation(async () => {
    created.closing = true;
    await sdkClose?.();
  });
  session.on("final", (text) => onFinal(created, text));
  session.on("partial", (text) => onPartial(created, text));
  session.on("error", () => {
    if (created.closing) flag(created, "error after close()");
    if (!created.errorsAllowed) flag(created, "stream error with the socket healthy");
  });
  for (const [i, t] of script.entries()) far.synth.push(...turnMessages(far.mode, i + 1, t));
  // One `produce` per synthesized frame; a frame cut later leaves its step a no-op.
  for (const _frame of far.synth) {
    void far.s.schedule(Promise.resolve(), "produce").then(() => produce(created));
  }
  return created;
}

/** Liveness and the close-side checks, once every scheduled task has run. */
async function checkSettled(near: Near, s: fc.Scheduler): Promise<void> {
  await s.waitIdle();
  for (const t of near.owed) {
    if (!near.committed.has(t)) flag(near, `turn ${t}'s end arrived but it never committed`);
  }
  const earlier = near.closed;
  const closing = beginClose(near);
  await s.waitIdle();
  await earlier;
  await closing;
  await flush();
  near.session.forceEndOfTurn?.();
  near.session.updateEndpointing?.(777);
  near.session.sendAudio(new Int16Array(960));
  const fake = near.far.fake as FakeTranscriber;
  if (near.wireAfterClose > 0) flag(near, `${near.wireAfterClose} wire call(s) after close()`);
  if (fake.close.mock.calls.length !== 1) {
    flag(near, `transcriber closed ${fake.close.mock.calls.length} times`);
  }
}

async function runOne(
  s: fc.Scheduler,
  mode: Mode,
  script: readonly TurnScript[],
  actions: readonly ActionKind[],
): Promise<string[]> {
  const far: Far = {
    s,
    mode,
    fake: null,
    synth: [],
    wire: [],
    started: new Set(),
    dead: false,
  };
  const near = await openNear(far, script);
  const seq = s.scheduleSequence(
    actions.map((kind, i) => ({
      label: `${i}:${kind}`,
      builder: async () => ACTIONS[kind](near),
    })),
  );
  await s.waitFor(seq.task);
  await checkSettled(near, s);
  return near.violations;
}

describe("AssemblyAI STT: turn commit racing force-endpoint, pairing and close", () => {
  test("each turn commits once, in order, never behind a later partial, and nothing after close", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.constantFrom<Mode>("formatted-pair", "single-final"),
        fc.array(turnArb, { minLength: 1, maxLength: 4 }),
        fc.array(actionArb, { minLength: 2, maxLength: 12 }),
        async (s, mode, script, actions) => {
          cov.runs++;
          const violations = await runOne(s, mode, script, actions);
          expect(violations, `${violations.join("\n")}\n${String(s)}`).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
    // Coverage floors, each under the observed minimum (`pnpm floors:sample
    // --runs 20`): an all-green property proves nothing about a state the
    // generator never reached.
    // Measured over 20 runs: 10-27.
    expect(cov.forcedCuts, "no forced end ever cut a turn").toBeGreaterThan(4);
    // Measured over 20 runs: 187-243.
    expect(cov.pairedCommits, "no formatted pair ever committed").toBeGreaterThan(130);
    // Measured over 20 runs: 308-438.
    expect(cov.turnsAfterClose, "no Turn reached the SDK after close()").toBeGreaterThan(220);
    // Measured over 20 runs: 126-173.
    expect(cov.farEndFailures, "the far end never failed mid-session").toBeGreaterThan(90);
    // Measured over 20 runs: 395-473.
    expect(cov.turnsCommitted, "no turn ever committed").toBeGreaterThan(300);
  });
});
