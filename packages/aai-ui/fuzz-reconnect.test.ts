// Copyright 2026 the AAI authors. MIT license.
/**
 * FUZZ HARNESS: randomized reconnect sequences over the REAL reconnecting
 * socket (partysocket) with a fuzzed `client-config` broker. Every attempt
 * re-derives its URL, so this is where the broker latch and the resume-id
 * plumbing can go wrong. Invariants:
 *
 *  - R1 a FAILED config lookup never latches "not a broker": once the broker
 *       answers with a `sessionUrl` again, the next attempt must dial the
 *       sandbox, not the platform's `/websocket` (whose WebSocket redirect
 *       browsers do not follow — that route never recovers).
 *  - R2 every attempt after the first `config` carries the resume id.
 *  - R3 a session the server retired for idleness is never re-dialed.
 *  - R4 the FIRST connection never replays history, and no later attempt
 *       replays it more than once (a duplicated replay doubles the agent's
 *       view of the conversation).
 *  - R5 the mirror of R1: an ANSWERED lookup naming no `sessionUrl` DOES latch
 *       ("a server is one or it isn't"), so no later attempt pays for another
 *       lookup — the whole point of the latch.
 *
 * Driven by fast-check over a generated step script. Several steps carry a
 * PRECONDITION on live socket state (open needs a connecting socket, a `config`
 * frame needs one that has not had one) which fast-check cannot know at
 * generation time, so a step whose precondition fails is a no-op — the same
 * treatment a state-dependent choice gets anywhere else in these harnesses.
 */

import fc from "fast-check";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { installAudioMocks } from "./_react-test-utils.ts";
import { MockWebSocket, makeConfig } from "./_session-core-test-utils.ts";
import { createSessionCore } from "./session-core.ts";
import { loadAudioModules } from "./session-core-audio-setup.ts";
import type { SessionCore } from "./session-core-types.ts";

function noop(): void {
  /* expected console output */
}

const SESSION_URL = "https://sandbox.example/session";
const PLATFORM_URL = "https://host.example/agent/";
const PLATFORM_WS_PREFIX = "wss://host.example/agent/websocket";
const SANDBOX_WS_PREFIX = "wss://sandbox.example/";

type ConfigOutcome = "broker" | "no-broker" | "http-error" | "network-error";
const OUTCOMES = ["broker", "no-broker", "http-error", "network-error"] as const;

/** What `GET client-config` does, per fuzzed outcome. */
const CONFIG_RESPONSES: Record<ConfigOutcome, () => Promise<Response>> = {
  broker: () =>
    Promise.resolve(new Response(JSON.stringify({ sessionUrl: SESSION_URL }), { status: 200 })),
  "no-broker": () => Promise.resolve(new Response("{}", { status: 200 })),
  "http-error": () => Promise.resolve(new Response("nope", { status: 503 })),
  "network-error": () => Promise.reject(new Error("offline")),
};

let created: MockWebSocket[] = [];
class TrackingWebSocket extends MockWebSocket {
  constructor(url: string) {
    super(url);
    created.push(this);
  }
}

/** How many `history` frames this socket carried to the server. */
function historyFrameCount(socket: MockWebSocket): number {
  return socket.send.mock.calls.filter((call) => {
    const data = call[0] as unknown;
    if (typeof data !== "string") return false;
    return (JSON.parse(data) as { type: string }).type === "history";
  }).length;
}

/**
 * One step of a reconnect script. `open`, `configFrame`, `userTurn`,
 * `idleTimeout` and `close` all need a live socket in the right state; a step
 * whose precondition does not hold is skipped rather than forced, since forcing
 * one would drive the socket through a transition the real client cannot make.
 */
type ReconnectStep =
  | { kind: "setConfigOutcome"; outcome: ConfigOutcome }
  | { kind: "open" }
  | { kind: "configFrame" }
  | { kind: "userTurn" }
  | { kind: "idleTimeout" }
  | { kind: "close"; withError: boolean }
  | { kind: "advanceBackoff" };

/** Weights mirror the roll thresholds this harness used before fast-check. */
const stepArb: fc.Arbitrary<ReconnectStep> = fc.oneof(
  {
    weight: 20,
    arbitrary: fc.record({
      kind: fc.constant("setConfigOutcome" as const),
      outcome: fc.constantFrom(...OUTCOMES),
    }),
  },
  { weight: 20, arbitrary: fc.record({ kind: fc.constant("open" as const) }) },
  { weight: 20, arbitrary: fc.record({ kind: fc.constant("configFrame" as const) }) },
  { weight: 12, arbitrary: fc.record({ kind: fc.constant("userTurn" as const) }) },
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("idleTimeout" as const) }) },
  {
    weight: 15,
    arbitrary: fc.record({
      kind: fc.constant("close" as const),
      withError: fc.boolean(),
    }),
  },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("advanceBackoff" as const) }) },
);

/** One run's mutable state. */
type Run = {
  core: SessionCore;
  log: string[];
  outcome: ConfigOutcome;
  fetchLog: ConfigOutcome[];
  /** Sockets that already received a `config` frame — one per connection. */
  configured: Set<MockWebSocket>;
  retiredByServer: boolean;
};

/** Give partysocket time to schedule and construct its next attempt. */
async function awaitNextAttempt(run: Run, before: number): Promise<void> {
  for (let i = 0; i < 40 && created.length === before; i++) {
    await vi.advanceTimersByTimeAsync(500);
    if (run.core.getSnapshot().state !== "connecting") break;
  }
}

function applyStep(run: Run, step: ReconnectStep, index: number): void {
  const socket = created.at(-1);
  if (step.kind === "setConfigOutcome") {
    run.outcome = step.outcome;
    run.log.push(`config lookup → ${run.outcome}`);
  } else if (step.kind === "open" && socket?.readyState === 0) {
    run.log.push("open");
    socket.simulateOpen();
  } else if (step.kind === "configFrame" && socket && !run.configured.has(socket)) {
    run.log.push("config frame");
    run.configured.add(socket);
    socket.simulateMessage(makeConfig(16_000, 24_000, "sess-fuzz"));
  } else if (step.kind === "userTurn" && socket) {
    run.log.push("user turn");
    socket.simulateMessage(JSON.stringify({ type: "user_transcript", text: `hi ${index}` }));
    socket.simulateMessage(JSON.stringify({ type: "agent_transcript", text: "hello" }));
    socket.simulateMessage(JSON.stringify({ type: "reply_done" }));
  } else if (step.kind === "idleTimeout" && socket) {
    run.log.push("idle_timeout (server retires)");
    socket.simulateMessage(JSON.stringify({ type: "idle_timeout" }));
    run.retiredByServer = true;
  } else if (step.kind === "close" && socket) {
    run.log.push("close");
    if (step.withError) socket.simulateError();
    socket.simulateClose(1006);
  } else {
    run.log.push("advance backoff");
  }
}

/** Throwing (not expecting) so these can live outside the `it` body. */
function fail(run: Run, why: string): never {
  throw new Error(
    `${why}\nops:\n  ${run.log.join("\n  ")}\nurls:\n  ${created.map((s) => s.url).join("\n  ")}`,
  );
}

/** R2: every attempt after the first config carries the resume id. */
function checkResumeIdCarried(run: Run): void {
  const urls = created.map((s) => s.url);
  const firstResumed = urls.findIndex((u) => u.includes("sessionId="));
  if (firstResumed === -1) return;
  for (const url of urls.slice(firstResumed)) {
    if (!url.includes("sessionId=sess-fuzz")) fail(run, `attempt lost the resume id: ${url}`);
  }
}

/** R4: history replay is a reconnect-only, once-per-connection frame. */
function checkHistoryReplay(run: Run): void {
  for (const [index, socket] of created.entries()) {
    const replays = historyFrameCount(socket);
    if (index === 0 && replays > 0) fail(run, "the first connection replayed history");
    if (replays > 1) fail(run, `socket ${index} replayed history ${replays}x`);
  }
}

/**
 * R1 + R5: with the broker answering again, the next attempt must dial the
 * sandbox — UNLESS a lookup already answered "not a broker", which latches by
 * design and must stop issuing lookups altogether.
 */
async function checkBrokerLatch(run: Run): Promise<void> {
  const latchedNonBroker = run.fetchLog.includes("no-broker");
  run.outcome = "broker";
  const before = created.length;
  const lookupsBefore = run.fetchLog.length;
  created.at(-1)?.simulateClose(1006);
  await awaitNextAttempt(run, before);
  const attempt = created.at(-1);
  if (run.retiredByServer || created.length === before || !attempt) return;
  if (latchedNonBroker) {
    if (run.fetchLog.length !== lookupsBefore) {
      fail(run, "kept re-fetching client-config after a non-broker answer");
    }
    if (!attempt.url.startsWith(PLATFORM_WS_PREFIX)) {
      fail(run, `expected the platform path after the non-broker latch: ${attempt.url}`);
    }
    return;
  }
  if (!attempt.url.startsWith(SANDBOX_WS_PREFIX)) {
    fail(run, `a failed lookup latched away the broker: ${attempt.url}`);
  }
}

async function runScript(steps: readonly ReconnectStep[]): Promise<void> {
  created = [];
  const run: Run = {
    core: createSessionCore({ platformUrl: PLATFORM_URL }),
    log: [],
    outcome: "broker",
    fetchLog: [],
    configured: new Set(),
    retiredByServer: false,
  };
  vi.stubGlobal("fetch", () => {
    run.fetchLog.push(run.outcome);
    return CONFIG_RESPONSES[run.outcome]();
  });

  run.core.start();
  await vi.advanceTimersByTimeAsync(0);

  try {
    for (const [index, step] of steps.entries()) {
      const before = created.length;
      applyStep(run, step, index);
      await awaitNextAttempt(run, before);
      // R3: a retired session is never re-dialed.
      if (run.retiredByServer && created.length !== before) {
        fail(run, "dialed again after idle retirement");
      }
    }

    checkResumeIdCarried(run);
    checkHistoryReplay(run);
    await checkBrokerLatch(run);
  } finally {
    // Always tear the socket down: shrinking replays this many times, and a
    // core left connecting keeps its backoff timer against the next replay's
    // fetch stub.
    run.core.disconnect();
    await vi.advanceTimersByTimeAsync(70_000);
  }
}

describe("fuzz: reconnect + broker resolution", () => {
  let audio: ReturnType<typeof installAudioMocks>;

  beforeEach(async () => {
    // Warm the memoized audio imports on real timers — module loading is real
    // I/O that fake timers cannot pump.
    await loadAudioModules();
    vi.useFakeTimers();
    created = [];
    audio = installAudioMocks();
    vi.stubGlobal("WebSocket", TrackingWebSocket);
    vi.spyOn(console, "warn").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.spyOn(console, "debug").mockImplementation(noop);
  });

  afterEach(() => {
    audio.restore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-brokers after failed lookups and always carries the resume id", async () => {
    await fc.assert(
      // `runScript` throws through `fail()` on a violation; fast-check
      // reports a thrown error directly, so wrapping it in an `expect`
      // would only bury the message under "promise rejected instead of
      // resolving".
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 14 }), (steps) =>
        runScript(steps),
      ),
      { numRuns: 60 },
    );
  }, 120_000);
});
