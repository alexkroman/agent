// Copyright 2026 the AAI authors. MIT license.
/**
 * `/inbox`'s delivery contract over generated interleavings of devices, notices
 * and answers.
 *
 * `inbox.test.ts` and `holders.test.ts` drive the inbox over a real loopback
 * socket, one hand-chosen schedule each. This drives it through in-memory
 * sockets (no port, so it stays in the unit tier) where `fc.scheduler` decides
 * when each device's answer and each socket's `close` event arrives, and the walk
 * interleaves connects, reconnects, drops, aborts, ack deadlines and the inbox's
 * own `close()` between them. Checked from outside, against a model:
 *
 * - **One notice in flight per CLIENT**: a notice's header goes out only when
 *   every earlier notice of that client is finished — each of its holders
 *   answered, timed out, or closed, or the step aborted it — and never two
 *   pending on one holder.
 * - **FIFO per client**: headers reach a client in `notify` call order.
 * - **Every open holder, and only open ones**: a notice is offered to exactly the
 *   holders open when its turn comes (a replaced or dropped socket is not one).
 * - **Header then its bytes**: a header's binary frames follow it on that socket
 *   with nothing between.
 * - **The outcome rule**: `busy` if any holder said busy, else `acked` if any
 *   acked, else `no-ack` if any stayed silent, else `disconnected`; `offline`
 *   with nobody to send to. A late or stale answer changes nothing.
 * - **Abort**: a notice aborted with a holder still unanswered rejects with the
 *   signal's reason; one aborted before its turn is never sent; one aborted after
 *   it was decided keeps its outcome.
 * - **Liveness**: every `notify` settles once answers, closes and deadlines run
 *   out — including those racing `close()`.
 *
 * Virtual time drives the ack deadline (a timer armed inside a tick lands one
 * millisecond late under fake timers, so every advance is `ACK_TIMEOUT_MS + 2`;
 * see `keyed-lock-property.test.ts`). The ping interval is set past any walk so
 * it never fires.
 */

import { EventEmitter } from "node:events";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { silentLogger } from "../_logger-test-utils.ts";
import { type ClientInbox, createClientInbox, INBOX_FRAME_BYTES } from "./inbox.ts";

const CLIENTS = ["speaker", "kitchen"] as const;
/** `""` is the default holder: no `?holder=` at all. */
const HOLDERS = ["", "page", "watch"] as const;
const AUDIO_SIZES = [0, 10, INBOX_FRAME_BYTES + 1] as const;
const ACK_TIMEOUT_MS = 1000;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

type Outcome = "acked" | "busy" | "no-ack" | "disconnected" | "offline";
/** How one holder's part of a notice ended; `withdrawn` is an abort's. */
type Answer = "acked" | "busy" | "no-ack" | "disconnected" | "withdrawn";
/** What a device does with a notice it is offered. */
type Reaction = "ack" | "busy" | "silent" | "ack-twice" | "stale";

type Op =
  | { k: "connect"; client: number; holder: number }
  | { k: "notify"; client: number; audio: number }
  | { k: "resume" }
  | { k: "drop"; pick: number }
  | { k: "expire" }
  | { k: "abort"; pick: number }
  | { k: "close" };

const nat = (max: number) => fc.nat({ max });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 14,
    arbitrary: fc.record({
      k: fc.constant("connect" as const),
      client: nat(CLIENTS.length - 1),
      holder: nat(HOLDERS.length - 1),
    }),
  },
  {
    weight: 22,
    arbitrary: fc.record({
      k: fc.constant("notify" as const),
      client: nat(CLIENTS.length - 1),
      audio: nat(AUDIO_SIZES.length - 1),
    }),
  },
  { weight: 34, arbitrary: fc.record({ k: fc.constant("resume" as const) }) },
  { weight: 7, arbitrary: fc.record({ k: fc.constant("drop" as const), pick: nat(7) }) },
  { weight: 7, arbitrary: fc.record({ k: fc.constant("expire" as const) }) },
  { weight: 8, arbitrary: fc.record({ k: fc.constant("abort" as const), pick: nat(7) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("close" as const) }) },
);

/** The devices connected before the walk starts, so most walks have someone to notify. */
const rosterArb = fc.array(
  fc.record({ client: nat(CLIENTS.length - 1), holder: nat(HOLDERS.length - 1) }),
  { minLength: 1, maxLength: 4 },
);

/** Consumed cyclically, one per header a device receives. Weighted to answers. */
const reactionsArb = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: fc.constant<Reaction>("ack") },
    { weight: 3, arbitrary: fc.constant<Reaction>("busy") },
    { weight: 1, arbitrary: fc.constant<Reaction>("silent") },
    { weight: 1, arbitrary: fc.constant<Reaction>("ack-twice") },
    { weight: 1, arbitrary: fc.constant<Reaction>("stale") },
  ),
  { minLength: 1, maxLength: 6 },
);

/**
 * States the walks must have REACHED. Floors sit under the OBSERVED MINIMUM
 * over 20 runs (`pnpm floors:sample --runs 20`), with the range beside each.
 */
const reached = {
  /** Notices called while another of their client was unsettled, then delivered. */
  queuedThenDelivered: 0,
  /** Notices offered to two or more holders at once. */
  multiHolder: 0,
  /** Notices that settled `busy` although another holder acked. */
  busyOverAck: 0,
  /** Holder parts ended by their socket closing mid-flight. */
  closedMidFlight: 0,
  /** Holder parts ended by the ack deadline. */
  timedOut: 0,
  /** Notices aborted with a holder still unanswered. */
  abortedInFlight: 0,
  /** Notices aborted while still waiting for their turn. */
  abortedQueued: 0,
  /** Reconnects that replaced a socket with a notice pending on it. */
  replacedMidFlight: 0,
  /** Answers that arrived for a part already over. */
  lateAnswers: 0,
  /** `close()` calls with a notice unsettled. */
  closedWithPending: 0,
};

type Sock = EventEmitter & {
  readonly OPEN: number;
  readyState: number;
  bufferedAmount: number;
  clientId: string;
  holderId: string;
  /** Binary frames the last header still owes. */
  owed: number;
  send(data: string | Uint8Array): void;
  ping(): void;
  terminate(): void;
  close(): void;
};

type Part = { sock: Sock; answer?: Answer };

type Notice = {
  index: number;
  id: string;
  clientId: string;
  bytes: number;
  controller: AbortController;
  reason: Error;
  offlineAtCall: boolean;
  /** Another of its client was unsettled when it was called. */
  queuedAtCall: boolean;
  headerSeq?: number;
  expected?: Set<Sock>;
  parts: Part[];
  abort?: "in-flight" | "before-turn" | "decided";
  result: { k: "pending" } | { k: "resolved"; value: Outcome } | { k: "rejected"; reason: unknown };
};

/** The module doc's rule, restated so the model does not import it. */
function rule(answers: readonly Answer[]): Outcome {
  if (answers.includes("busy")) return "busy";
  if (answers.includes("acked")) return "acked";
  return answers.includes("no-ack") ? "no-ack" : "disconnected";
}

const live = (part: Part) => part.answer === undefined;

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** One generated walk: the inbox, its in-memory sockets, and the model beside them. */
class Walk {
  readonly problems: string[] = [];
  readonly socks: Sock[] = [];
  readonly notices: Notice[] = [];
  readonly inbox: ClientInbox = createClientInbox({ logger: silentLogger, pingMs: 1e9 });
  private seq = 0;
  private reacted = 0;
  private closed = false;
  private readonly s: fc.Scheduler;
  private readonly reactions: readonly Reaction[];

  constructor(s: fc.Scheduler, reactions: readonly Reaction[]) {
    this.s = s;
    this.reactions = reactions;
  }

  openOf(clientId: string): Sock[] {
    return this.socks.filter((sock) => sock.clientId === clientId && sock.readyState === OPEN);
  }

  liveParts(sock: Sock): Part[] {
    return this.notices.flatMap((n) => n.parts.filter((p) => p.sock === sock && live(p)));
  }

  pending(): Notice[] {
    return this.notices.filter((n) => n.result.k === "pending");
  }

  /** Deliver one device answer when the scheduler says, if the socket can still carry it. */
  answer(sock: Sock, type: "ack" | "busy", id: string): void {
    void this.s.schedule(Promise.resolve(), `${type} ${id}`).then(() => {
      if (sock.readyState !== OPEN) return;
      const part = this.notices.find((n) => n.id === id)?.parts.find((p) => p.sock === sock);
      if (part && live(part)) part.answer = type === "ack" ? "acked" : "busy";
      else if (part) reached.lateAnswers++;
      sock.emit("message", Buffer.from(JSON.stringify({ type, id })), false);
    });
  }

  /** Server terminate or device close: CLOSING now, the `close` event when scheduled. */
  drop(sock: Sock): void {
    if (sock.readyState !== OPEN) return;
    sock.readyState = CLOSING;
    void this.s.schedule(Promise.resolve(), "close").then(() => {
      sock.readyState = CLOSED;
      for (const part of this.liveParts(sock)) {
        part.answer = "disconnected";
        reached.closedMidFlight++;
      }
      sock.emit("close", 1006, Buffer.alloc(0));
    });
  }

  /** A notice's FIRST header: its turn has come, so everything before it must be over. */
  firstHeader(notice: Notice): void {
    notice.headerSeq = this.seq++;
    notice.expected = new Set(this.openOf(notice.clientId));
    if (notice.queuedAtCall) reached.queuedThenDelivered++;
    for (const other of this.notices) {
      if (other === notice || other.clientId !== notice.clientId) continue;
      if (other.parts.some(live)) {
        this.problems.push(`${notice.id} was sent while ${other.id} was in flight`);
      }
    }
  }

  onHeader(sock: Sock, id: string, bytes: number): void {
    const notice = this.notices.find((n) => n.id === id);
    if (!notice || notice.clientId !== sock.clientId) {
      this.problems.push(`header ${id} reached a socket of ${sock.clientId}`);
      return;
    }
    if (notice.abort === "before-turn") this.problems.push(`${id} was sent after it was aborted`);
    if (notice.headerSeq === undefined) this.firstHeader(notice);
    if (!notice.expected?.has(sock)) this.problems.push(`${id} was offered to a holder not open`);
    if (this.liveParts(sock).length > 0) {
      this.problems.push(`${id} was offered to a holder already pending`);
    }
    notice.parts.push({ sock });
    sock.owed = Math.ceil(bytes / INBOX_FRAME_BYTES);
    this.react(sock, id);
  }

  react(sock: Sock, id: string): void {
    const reaction = this.reactions[this.reacted++ % this.reactions.length] as Reaction;
    if (reaction === "ack" || reaction === "ack-twice") this.answer(sock, "ack", id);
    if (reaction === "ack-twice") this.answer(sock, "ack", id);
    if (reaction === "busy") this.answer(sock, "busy", id);
    if (reaction === "stale") this.answer(sock, "ack", `stale-${id}`);
  }

  onSend(sock: Sock, data: string | Uint8Array): void {
    if (typeof data !== "string") {
      if (sock.owed === 0) this.problems.push("a binary frame no header owed");
      sock.owed = Math.max(0, sock.owed - 1);
      return;
    }
    if (sock.owed > 0) this.problems.push("a text frame between a header and its bytes");
    const frame = JSON.parse(data) as { type: string; id: string; bytes: number };
    if (frame.type === "notice") this.onHeader(sock, frame.id, frame.bytes);
  }

  connect(clientId: string, holderId: string): void {
    if (this.closed) return;
    const replaced = this.socks.find(
      (sock) =>
        sock.readyState === OPEN && sock.clientId === clientId && sock.holderId === holderId,
    );
    if (replaced && this.liveParts(replaced).length > 0) reached.replacedMidFlight++;
    const sock: Sock = Object.assign(new EventEmitter(), {
      OPEN,
      readyState: OPEN,
      bufferedAmount: 0,
      clientId,
      holderId,
      owed: 0,
      send: (data: string | Uint8Array) => this.onSend(sock, data),
      ping: () => undefined,
      terminate: () => this.drop(sock),
      close: () => this.drop(sock),
    });
    this.socks.push(sock);
    const query = holderId ? `&holder=${holderId}` : "";
    this.inbox.attach(sock as unknown as WebSocket, `/inbox?client=${clientId}${query}`);
  }

  notify(clientId: string, bytes: number): void {
    const index = this.notices.length;
    const id = `n${index}`;
    const notice: Notice = {
      index,
      id,
      clientId,
      bytes,
      controller: new AbortController(),
      reason: new Error(`abort ${id}`),
      offlineAtCall: this.closed || this.openOf(clientId).length === 0,
      queuedAtCall: this.pending().some((n) => n.clientId === clientId),
      parts: [],
      result: { k: "pending" },
    };
    this.notices.push(notice);
    const options = { ackTimeoutMs: ACK_TIMEOUT_MS, signal: notice.controller.signal };
    const audio = new Uint8Array(bytes);
    this.inbox.notify(clientId, { id, event: "reminder", audio }, options).then(
      (value) => {
        notice.result = { k: "resolved", value };
      },
      (reason: unknown) => {
        notice.result = { k: "rejected", reason };
      },
    );
  }

  abort(pick: number): void {
    const candidates = this.pending().filter((n) => !n.abort);
    const notice = candidates[pick % Math.max(1, candidates.length)];
    if (!notice) return;
    if (notice.headerSeq === undefined) {
      notice.abort = "before-turn";
      if (!notice.offlineAtCall) reached.abortedQueued++;
    } else if (notice.parts.some(live)) {
      notice.abort = "in-flight";
      reached.abortedInFlight++;
      for (const part of notice.parts) part.answer ??= "withdrawn";
    } else {
      notice.abort = "decided";
    }
    notice.controller.abort(notice.reason);
  }

  /** Every part whose header is out and still unanswered times out. */
  async expire(): Promise<void> {
    for (const part of this.notices.flatMap((n) => n.parts)) {
      if (!live(part)) continue;
      part.answer = "no-ack";
      reached.timedOut++;
    }
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 2);
  }

  close(): void {
    if (this.closed) return;
    if (this.pending().length > 0) reached.closedWithPending++;
    this.closed = true;
    this.inbox.close();
  }

  async step(op: Op): Promise<void> {
    if (op.k === "connect")
      this.connect(CLIENTS[op.client] as string, HOLDERS[op.holder] as string);
    else if (op.k === "notify") {
      this.notify(CLIENTS[op.client] as string, AUDIO_SIZES[op.audio] as number);
    } else if (op.k === "resume") {
      if (this.s.count() > 0) await this.s.waitOne();
    } else if (op.k === "drop") {
      const open = this.socks.filter((sock) => sock.readyState === OPEN);
      const sock = open[op.pick % Math.max(1, open.length)];
      if (sock) this.drop(sock);
    } else if (op.k === "expire") await this.expire();
    else if (op.k === "abort") this.abort(op.pick);
    else this.close();
    await settle();
  }

  /** Answers and closes, then deadlines, until nothing is owed. */
  async quiesce(): Promise<void> {
    for (let round = 0; round <= this.notices.length + 2; round++) {
      await this.s.waitIdle();
      await settle();
      if (this.pending().length === 0 && this.s.count() === 0) return;
      await this.expire();
      await settle();
    }
  }
}

async function runWalk(
  s: fc.Scheduler,
  roster: readonly { client: number; holder: number }[],
  ops: readonly Op[],
  reactions: readonly Reaction[],
): Promise<string[]> {
  const walk = new Walk(s, reactions);
  try {
    for (const { client, holder } of roster) {
      walk.connect(CLIENTS[client] as string, HOLDERS[holder] as string);
    }
    for (const op of ops) await walk.step(op);
    await walk.quiesce();
  } finally {
    walk.inbox.close();
  }
  for (const notice of walk.notices) checkOutcome(notice, walk.problems);
  checkOrder(walk.notices, walk.problems);
  return walk.problems;
}

/** What a notice the step aborted may settle with. */
function checkAborted(notice: Notice, got: string, problems: string[]): void {
  const { result } = notice;
  const rejected = result.k === "rejected" && result.reason === notice.reason;
  const offline = notice.abort === "before-turn" && got === "offline";
  if (!(rejected || offline)) problems.push(`${notice.id}: aborted, but settled ${got}`);
}

/** One notice's settled result against the model. */
function checkOutcome(notice: Notice, problems: string[]): void {
  const { id, result } = notice;
  if (result.k === "pending") {
    problems.push(`${id} never settled`);
    return;
  }
  const got = result.k === "resolved" ? result.value : result.k;
  if (notice.parts.some(live)) problems.push(`${id} settled with a holder unanswered`);
  if (notice.offlineAtCall || notice.headerSeq === undefined) {
    if (notice.abort === "before-turn") checkAborted(notice, got, problems);
    else if (got !== "offline") problems.push(`${id}: never sent, but settled ${got}`);
    return;
  }
  if (notice.abort === "in-flight") {
    checkAborted(notice, got, problems);
    return;
  }
  if (notice.parts.length !== notice.expected?.size) {
    problems.push(`${id}: offered to ${notice.parts.length} of ${notice.expected?.size} open`);
  }
  const answers = notice.parts.map((part) => part.answer as Answer);
  const want = rule(answers);
  if (got !== want) problems.push(`${id}: holders said [${answers}], settled ${got}`);
  if (answers.length > 1) reached.multiHolder++;
  if (want === "busy" && answers.includes("acked")) reached.busyOverAck++;
}

/** FIFO per client: headers went out in `notify` call order. */
function checkOrder(notices: readonly Notice[], problems: string[]): void {
  for (const clientId of CLIENTS) {
    const sent = notices.filter((n) => n.clientId === clientId && n.headerSeq !== undefined);
    const order = [...sent].sort((a, b) => (a.headerSeq as number) - (b.headerSeq as number));
    if (order.some((n, i) => n !== sent[i])) {
      problems.push(
        `${clientId}: sent [${order.map((n) => n.id)}] for calls [${sent.map((n) => n.id)}]`,
      );
    }
  }
}

describe("the client inbox under a generated interleaving", () => {
  test("one notice in flight per client, in call order, settled by the holders' answers", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        rosterArb,
        fc.array(opArb, { minLength: 1, maxLength: 40 }),
        reactionsArb,
        async (s, roster, ops, reactions) => {
          // Virtual time per run, released whatever the run does.
          vi.useFakeTimers();
          try {
            expect(await runWalk(s, roster, ops, reactions)).toEqual([]);
          } finally {
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 600 },
    );

    // Ranges over 20 runs, each floor under the OBSERVED MINIMUM.
    expect(reached.queuedThenDelivered, "no notice ever waited its turn").toBeGreaterThan(60); // 90-130
    expect(reached.multiHolder, "no notice ever reached two holders").toBeGreaterThan(120); // 172-244
    expect(reached.busyOverAck, "no busy ever outweighed an ack").toBeGreaterThan(12); // 22-62
    expect(reached.closedMidFlight, "no socket ever closed mid-notice").toBeGreaterThan(35); // 52-90
    expect(reached.timedOut, "no holder ever timed out").toBeGreaterThan(150); // 208-251
    expect(reached.abortedInFlight, "no notice was ever aborted in flight").toBeGreaterThan(40); // 60-93
    // Small whole range (4-13 over 20 runs), so only "reached at all".
    expect(reached.abortedQueued, "no notice was ever aborted in the queue").toBeGreaterThan(0);
    expect(reached.replacedMidFlight, "no reconnect ever replaced a busy socket").toBeGreaterThan(
      15,
    ); // 26-44
    expect(reached.lateAnswers, "no answer ever arrived late").toBeGreaterThan(120); // 175-254
    // Small whole range (2-18 over 20 runs): `close()` is a rare op on purpose,
    // since it ends the walk's interesting part.
    expect(reached.closedWithPending, "close() never raced a notice").toBeGreaterThan(0);
  });
});
