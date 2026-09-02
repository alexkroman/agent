// Copyright 2026 the AAI authors. MIT license.
/**
 * The follow-up queue's DEFINING property, over interleavings nobody wrote by
 * hand.
 *
 * > At every point in any interleaving, every text the user submitted is in
 * > exactly one of: queued, in flight, in the composer, or in the transcript.
 *
 * That sentence is already written down in prose, twice, as the reason this
 * module exists: `chat-queue.ts` opens with "it used to be disabled, which
 * silently swallowed anything typed mid-turn", and the flush effect's own
 * comment says parking a failed turn's queue "would wedge the composer
 * permanently". Everything in the reducer is a mechanism in service of those
 * two, and `chat-queue.test.ts` states the mechanisms — twenty tests, each
 * pinning ONE transition in isolation. None composes two, and a queue is a
 * machine three actors move at once: the user (submit, dismiss, Stop, type),
 * the flush effect, and the chat's own status. The defect this suite was
 * written for passes all twenty.
 *
 * ## What the model is
 *
 * A conservation law, so the model is a multiset of "texts the user is still
 * owed" and the assertion is where each one lives. Four places, and the split
 * that matters is between the two the USER can see and the two they cannot:
 *
 * - **visible** — a queued row above the composer, the composer's own text, a
 *   message in the transcript. A text in two of these is a text the user is
 *   about to send twice.
 * - **invisible** — a `sendMessage` the chat has not answered yet. A text here
 *   is owed and not yet anywhere the user could act on it: fine transiently,
 *   a LOSS if it settles that way.
 *
 * So: never in two visible places, never in none, and at rest exactly one.
 *
 * The queue itself holds no text in flight, and that is a FINDING rather than an
 * omission: `inFlight?: string` on the reducer was the first fix proposed, and
 * this property rejected it. Because of fact 1 below, a dispatched text is in
 * the transcript by the time anything can go wrong with it, so a reducer that
 * kept a copy to hand back on `error` produced a second visible copy — which is
 * what the duplication half of the law above catches. What the queue lacked was
 * never the text. It was a latch release that always arrives.
 *
 * ## Why the chat is modelled rather than mocked
 *
 * The interesting interleavings are all in the chat's own ordering, and two
 * facts about `ai@7` decide what the property may assume. Both were verified by
 * execution against the installed version rather than read off the source:
 *
 * 1. **`sendMessage` pushes the user message BEFORE the request.**
 *    `Chat.sendMessage` appends to `state.messages`, then `makeRequest` sets
 *    `submitted`, then the transport runs. A turn that FAILS therefore still
 *    leaves the text in the transcript — measured: a transport that throws
 *    leaves `messages` holding the text, statuses `["submitted", "error"]`.
 *    `error` is evidence of DELIVERY, not of loss, and a queue that handed the
 *    text back there would be creating the second copy. `sdkAccepts` is the
 *    only step that reaches the transcript for this reason.
 * 2. **`stop()` abandons a send that has not started.** It aborts every entry
 *    in `pendingMessagePreparations` and `sendMessage` returns before pushing
 *    anything. Measured: a `sendMessage` immediately followed by `stop()`
 *    leaves 0 requests, 0 status changes and 0 messages — the text is
 *    annihilated unless the queue still holds it.
 *
 * ## The one scheduling assumption, and why it is the only one
 *
 * **No USER step fires while a handover is pending.** `sendMessage` reaches
 * `pushMessage` and `setStatus("submitted")` through microtasks only, and
 * React's store flush is itself a microtask — so both have run by the time the
 * browser dispatches the next input event, which is a TASK. A keypress or a
 * click cannot land inside that window, so neither can the model's user.
 *
 * That is a statement about the event loop, which is why it is the assumption
 * this model is willing to make. The two facts above are library internals,
 * and the interleavings they make unreachable are generated anyway — the render
 * and the SDK steps may enter the dispatch window freely, which is exactly
 * where the latch earns its keep. A hook whose entire input surface is
 * `{status, busy, chatReady}` may not quietly depend on which commits React
 * chooses to coalesce or on when the SDK pushes a message; nothing in this
 * package asserts either, and nothing in the module tells a reader they hold.
 *
 * Which matters because THREE such coincidences are what keep the pre-fix
 * wedge off a user's screen today, none of them owned here: React committing
 * `submitted` and `error` separately, the SDK pushing before it requests, and
 * `Composer` only rendering Stop while `busy`. An `ai` bump, a React scheduling
 * change, or a Stop offered one state earlier moves any of them, and nobody
 * reviewing that change would be looking at this file.
 *
 * One residual gap this rule DOES hide, recorded because it is real: `submit`
 * decides between "join the queue" and "go out now" from `hasPendingWork`,
 * which cannot see a `sendMessage` the chat has not answered — so a second
 * Enter inside that same window would open a second concurrent turn. Only the
 * event-loop argument above closes it. Fixing it means routing every submit
 * through the queue, which costs a frame of a queued row on the first message
 * of every turn; it is a separate decision from this one.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  EMPTY_QUEUE,
  hasPendingWork,
  type MessageQueue,
  type QueueAction,
  queueReducer,
} from "./chat-queue.ts";
import {
  type QueueContext,
  type QueueEvent,
  type QueueIo,
  runQueueEvent,
} from "./use-message-queue.ts";

/**
 * The world the queue sits in: its own state, the composer, the transcript,
 * and as much of `useChat` as the two verified facts above require.
 */
type World = {
  queue: MessageQueue;
  /** The composer's textarea. */
  input: string;
  /** User messages the chat has taken responsibility for. */
  transcript: string[];
  /** Handed to `sendMessage`, not yet pushed or abandoned. */
  handedOver: string | null;
  /**
   * `sendMessage`'s own completion, held until the modelled turn ends. This is
   * the signal `void sendMessage(...)` used to throw away.
   */
  settleHandover: (() => void) | null;
  status: QueueContext["status"];
  busy: boolean;
  chatReady: boolean;
  /** Every text the user pressed Enter on. */
  owed: string[];
  /**
   * Breaches of "one turn at a time", recorded by the io rather than asserted
   * there: an `expect` in a helper is `noMisplacedAssertion`, and recording is
   * better anyway — the property body checks this after every step, so the
   * breach is attributed to the step that caused it and still shrinks.
   */
  violations: string[];
};

/** One step of a generated interleaving. */
type Step =
  /** The user types at the end of the composer. */
  | { readonly kind: "type" }
  /** Enter: the composer's whole content goes to the queue, and clears. */
  | { readonly kind: "enter" }
  /** The ✕ on a queued row. */
  | { readonly kind: "dismiss"; readonly nth: number }
  /** Stop. */
  | { readonly kind: "stop" }
  /** A render happened and the flush effect ran. */
  | { readonly kind: "settle" }
  /** The chat pushed the pending message and opened its turn. */
  | { readonly kind: "sdkAccepts" }
  /** The open turn began streaming. */
  | { readonly kind: "sdkStreams" }
  /** The open turn finished. */
  | { readonly kind: "sdkFinishes" }
  /** The open turn failed. */
  | { readonly kind: "sdkFails" }
  /**
   * The chat opened the turn AND ended it, with React committing neither
   * separately — so nothing ever rendered `busy`. There are two, one per
   * outcome, and they are NAMED steps rather than two adjacent generated ones
   * because this is the interleaving the whole suite is about: a floor over
   * "did the generator happen to emit them back to back" is a floor over
   * fast-check's weights, and it measured 3 occurrences in 6,000 runs.
   */
  | { readonly kind: "sdkAcceptsAndFails" }
  | { readonly kind: "sdkAcceptsAndFinishes" }
  /** `/studio/status` came or went. */
  | { readonly kind: "chatReady"; readonly ready: boolean };

/** The steps a human performs, which the event-loop rule above constrains. */
const USER_STEPS: ReadonlySet<Step["kind"]> = new Set(["type", "enter", "dismiss", "stop"]);

/**
 * A step's arguments are generated; whether it can HAPPEN is decided against
 * live state, and a step whose precondition fails no-ops. Forcing one would
 * drive the world through a transition it cannot really make.
 *
 * **`settle` is not in here.** React commits every state the chat passes
 * through and flushes pending passive effects before the next commit, so a
 * render follows every step — {@link step} runs one, and generating them
 * instead spent the budget on ordering luck: reaching a DISPATCHED follow-up
 * needed four specific steps in sequence, so almost every dispatch happened in
 * the standstill loop at the end of a run where nothing can fail afterwards.
 * The freedom that matters — React NOT rendering between two chat transitions
 * — is named explicitly by the two compound steps instead, which is the only
 * way a floor over it means anything.
 *
 * The weights only affect how often the interesting states are reached, which
 * is what the floors at the bottom actually check.
 */
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: fc.constant<Step>({ kind: "enter" }), weight: 6 },
  { arbitrary: fc.constant<Step>({ kind: "sdkAccepts" }), weight: 8 },
  { arbitrary: fc.constant<Step>({ kind: "sdkStreams" }), weight: 2 },
  { arbitrary: fc.constant<Step>({ kind: "sdkFinishes" }), weight: 5 },
  { arbitrary: fc.constant<Step>({ kind: "sdkFails" }), weight: 4 },
  { arbitrary: fc.constant<Step>({ kind: "sdkAcceptsAndFails" }), weight: 5 },
  { arbitrary: fc.constant<Step>({ kind: "sdkAcceptsAndFinishes" }), weight: 5 },
  { arbitrary: fc.constant<Step>({ kind: "stop" }), weight: 2 },
  { arbitrary: fc.constant<Step>({ kind: "type" }), weight: 2 },
  {
    arbitrary: fc.integer({ min: 0, max: 2 }).map((nth): Step => ({ kind: "dismiss", nth })),
    weight: 1,
  },
  {
    arbitrary: fc.boolean().map((ready): Step => ({ kind: "chatReady", ready })),
    weight: 1,
  },
);

/**
 * The label a `type` step appends, drawn from a counter rather than generated.
 *
 * Every owed text has to stay identifiable in the composer AFTER a hand-back,
 * and `drainText` joins several with a blank line — so accounting is by
 * CONTAINMENT and the labels have to be unique and non-overlapping. Generating
 * strings would buy nothing: what is under test is the ordering of a machine,
 * not what the text is, and `"m10".includes("m1")` would make the accounting
 * lie.
 */
function labeller(): () => string {
  let n = 0;
  return () => `<${n++}>`;
}

/** Where one owed text currently lives. */
function placesOf(world: World, text: string) {
  const holds = (candidate: string) => candidate.includes(text);
  return {
    queued: world.queue.items.some((item) => holds(item.text)),
    composer: holds(world.input),
    transcript: world.transcript.some(holds),
    handedOver: world.handedOver !== null && holds(world.handedOver),
  };
}

type Places = ReturnType<typeof placesOf>;

/** The three the user can see and act on. */
const visibleCount = (where: Places) =>
  Number(where.queued) + Number(where.composer) + Number(where.transcript);

/** Somewhere — visible, or owed by a send nobody has answered yet. */
const anywhere = (where: Places) => visibleCount(where) + Number(where.handedOver);

/**
 * States the generated interleavings have to have REACHED, or every assertion
 * below is satisfied by a corpus that never queued anything.
 *
 * Floors sit under the OBSERVED MINIMUM over 20 runs with the range recorded
 * beside each — never a fraction of the mean. What a generated walk reaches is
 * correlated within a run rather than independent per step, so these
 * distributions have long left tails.
 */
const reached = {
  /** Follow-ups the flush effect dispatched out of the queue. */
  dispatches: 0,
  /** Turns that failed. */
  failures: 0,
  /** Turns whose whole lifecycle React committed at once, so `busy` never rendered. */
  coalescedTurns: 0,
  /**
   * Coalesced turns that landed on an ARMED latch — the wedge's own state, and
   * what the pre-fix counterexample shrinks to. Nothing but the handover's own
   * settlement can release the latch from here.
   */
  coalescedOverLatch: 0,
  /** Hand-backs that really moved text into the composer. */
  drains: 0,
  /** Settles that found two or more follow-ups waiting. */
  multiQueued: 0,
  /** Stops that landed while a turn was live. */
  stopsMidTurn: 0,
  /**
   * Settles that ran inside the dispatch window — a handover the chat has not
   * answered, where `status` still reads `ready`. The latch's entire job: a
   * settle here would otherwise open a second concurrent turn.
   */
  settlesInDispatchWindow: 0,
};

/**
 * The modelled `sendMessage` promise resolving: the handover it opened is over,
 * however it ended. Every step that ends a turn calls this, which is exactly
 * when `useChat`'s own promise settles.
 */
function endHandover(world: World): void {
  const settle = world.settleHandover;
  world.settleHandover = null;
  settle?.();
}

/**
 * Everything {@link runQueueEvent} is handed, over one world.
 *
 * The one-turn-at-a-time check RECORDS rather than asserts: an `expect` in a
 * helper is `noMisplacedAssertion`, and recording is better anyway — the
 * property body checks `violations` after every step, so a breach is attributed
 * to the step that caused it and still shrinks.
 */
function ioFor(world: World): QueueIo {
  return {
    dispatch: (action: QueueAction) => {
      world.queue = queueReducer(world.queue, action);
    },
    setInput: (update: (current: string) => string) => {
      world.input = update(world.input);
    },
    send: (text: string, onSettled: () => void) => {
      // One turn at a time is the queue's whole job, so a second live send is
      // a breach rather than something the model absorbs.
      if (world.handedOver !== null) {
        world.violations.push(`sent ${text} while ${world.handedOver} was still pending`);
      }
      if (world.busy) world.violations.push(`sent ${text} while a turn was in flight`);
      world.handedOver = text;
      world.settleHandover = onSettled;
    },
  };
}

/** The steps a human takes. */
function applyUser(world: World, step: Step, label: () => string, io: QueueIo): void {
  const event = (queueEvent: QueueEvent) => {
    runQueueEvent(queueEvent, world.queue, ctxOf(world), io);
  };
  switch (step.kind) {
    case "type":
      world.input += (world.input === "" ? "" : "\n\n") + label();
      return;
    case "enter": {
      // `Composer.submit`: trim, bail on empty, clear the field, hand over.
      const text = world.input.trim();
      if (text === "" || !world.chatReady) return;
      world.input = "";
      world.owed.push(text);
      event({ kind: "submit", text });
      return;
    }
    case "dismiss": {
      const item = world.queue.items[step.nth];
      if (item === undefined) return;
      // A dismissed row stops being owed — the user withdrew it.
      world.owed = world.owed.filter((text) => !item.text.includes(text));
      event({ kind: "remove", id: item.id });
      return;
    }
    default: {
      const before = world.input;
      if (world.busy) reached.stopsMidTurn++;
      event({ kind: "stop" });
      if (world.input !== before) reached.drains++;
      // A Stop aborts the live turn, whose message is already in the
      // transcript (fact 1) — and the aborted `sendMessage` resolves.
      if (world.busy) {
        world.busy = false;
        world.status = "ready";
        endHandover(world);
      }
      return;
    }
  }
}

/** A render, and the effect that runs with it. */
function applySettle(world: World, io: QueueIo): void {
  if (world.handedOver !== null) reached.settlesInDispatchWindow++;
  if (world.queue.items.length >= 2) reached.multiQueued++;
  const before = { input: world.input, latched: world.queue.dispatched };
  runQueueEvent({ kind: "settle" }, world.queue, ctxOf(world), io);
  // Keyed off the LATCH going up, not off `items` shrinking: the error path's
  // hand-back shrinks `items` too, so an earlier draft counted drains as
  // dispatches and read 72 where the real number was 0.
  if (!before.latched && world.queue.dispatched) reached.dispatches++;
  if (world.input !== before.input) reached.drains++;
}

/** What the chat does on its own. */
function applyChat(world: World, step: Step): void {
  switch (step.kind) {
    case "sdkAccepts":
      if (world.handedOver === null) return;
      world.transcript.push(world.handedOver);
      world.handedOver = null;
      world.status = "submitted";
      world.busy = true;
      return;
    case "sdkStreams":
      if (!world.busy) return;
      world.status = "streaming";
      return;
    case "sdkFinishes":
      if (!world.busy) return;
      world.busy = false;
      world.status = "ready";
      endHandover(world);
      return;
    case "sdkFails":
      if (!world.busy) return;
      reached.failures++;
      world.busy = false;
      world.status = "error";
      endHandover(world);
      return;
    case "chatReady":
      world.chatReady = step.ready;
      return;
    default:
      applyCoalescedTurn(world, step.kind === "sdkAcceptsAndFails");
      return;
  }
}

/**
 * A turn React committed all at once: opened and ended with nothing in between
 * ever rendering `busy`, so the latch's usual release never fires and only the
 * handover's own settlement can disarm it.
 */
function applyCoalescedTurn(world: World, failed: boolean): void {
  if (world.handedOver === null) return;
  // The push happens either way (fact 1).
  world.transcript.push(world.handedOver);
  world.handedOver = null;
  reached.coalescedTurns++;
  if (world.queue.dispatched) reached.coalescedOverLatch++;
  if (failed) reached.failures++;
  world.status = failed ? "error" : "ready";
  endHandover(world);
}

const ctxOf = (world: World): QueueContext => ({
  status: world.status,
  busy: world.busy,
  chatReady: world.chatReady,
});

/** Apply one step, or no-op when its precondition does not hold. */
function apply(world: World, step: Step, label: () => string): void {
  // The event-loop rule: a keypress or a click cannot land between
  // `sendMessage` and the chat answering it, so the answer is already in by
  // the time a user step runs. Advancing the chat here rather than dropping
  // the step is what keeps the generated prefixes short enough to reach a
  // dispatched follow-up at all — a no-op would spend a step on nothing.
  // See the header for why this is the one scheduling assumption made.
  if (world.handedOver !== null && USER_STEPS.has(step.kind)) {
    applyChat(world, { kind: "sdkAccepts" });
  }
  const io = ioFor(world);
  if (USER_STEPS.has(step.kind)) {
    applyUser(world, step, label, io);
    return;
  }
  if (step.kind === "settle") {
    applySettle(world, io);
    return;
  }
  applyChat(world, step);
}

/**
 * One generated step, plus the render that always follows it.
 */
function step(world: World, generated: Step, label: () => string): void {
  apply(world, generated, label);
  apply(world, { kind: "settle" }, label);
}

/**
 * Drive the world to a standstill the way a real one reaches it: the chat
 * answers the outstanding send, the turn ends, and the flush effect runs on
 * every state it produces until nothing changes.
 *
 * A settle that never stops changing anything is an effect loop, and the cap
 * is how that reports as a failure rather than as a hang.
 */
function quiesce(world: World, label: () => string): boolean {
  world.chatReady = true;
  for (let i = 0; i < 60; i++) {
    const before = {
      queue: world.queue,
      input: world.input,
      handedOver: world.handedOver,
      busy: world.busy,
    };
    // The settle comes FIRST, and the order is the whole point: React commits
    // every state the chat passes through and runs the effect on each one, so
    // a standstill that advanced the chat past a state without rendering it
    // would manufacture a wedge the effect had no chance to release.
    apply(world, { kind: "settle" }, label);
    if (world.handedOver !== null) apply(world, { kind: "sdkAccepts" }, label);
    else if (world.busy) apply(world, { kind: "sdkFinishes" }, label);
    if (
      world.queue === before.queue &&
      world.input === before.input &&
      world.handedOver === before.handedOver &&
      world.busy === before.busy
    ) {
      return true;
    }
  }
  // Reported rather than thrown: a settle that never stops changing anything is
  // an effect loop, and the caller turns that into a failure rather than a hang.
  return false;
}

function newWorld(): World {
  return {
    queue: EMPTY_QUEUE,
    input: "",
    transcript: [],
    handedOver: null,
    settleHandover: null,
    status: "ready",
    busy: false,
    chatReady: true,
    owed: [],
    violations: [],
  };
}

describe("the follow-up queue's conservation law", () => {
  test("owes every submitted text exactly once, and never holds the latch at rest", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 40 }), (steps) => {
        const label = labeller();
        const world = newWorld();
        // Seed the composer, or `enter` has nothing to submit.
        apply(world, { kind: "type" }, label);

        for (const generated of steps) {
          step(world, generated, label);
          expect(world.violations, "more than one turn was in flight at once").toEqual([]);
          for (const text of world.owed) {
            const where = placesOf(world, text);
            expect(
              anywhere(where),
              `${text} is owed and is NOWHERE: ${JSON.stringify(where)}`,
            ).toBeGreaterThan(0);
            expect(
              visibleCount(where),
              `${text} is in two places the user can act on: ${JSON.stringify(where)}`,
            ).toBeLessThan(2);
          }
          // Refill the composer so the next `enter` has something to submit.
          // Written straight into the field rather than run as a `type` STEP,
          // and the difference is not cosmetic: a user step accepts the
          // pending handover (the event-loop rule above), so a refill that
          // went through the machinery consumed the dispatch window after
          // every send — the latch's own job went unexercised, the
          // one-turn-at-a-time assertion had nothing to bite on, and the
          // coalesced-turn steps could never fire. Measured both ways: 18
          // dispatches per 1,000 runs reached the generated phase, against 74
          // once this stopped being a step. The generated `type` step is the
          // modelled user typing; this is bookkeeping.
          if (world.input === "") world.input = label();
        }

        expect(quiesce(world, label), "the flush effect never reached a fixpoint").toBe(true);

        // AT REST — the three claims a user would report as one bug.
        expect(
          world.queue.dispatched,
          "the latch is held over a queue with nothing in flight: every later submit joins " +
            "the queue, the effect returns before it can flush, and Publish stays locked",
        ).toBe(false);
        expect(
          hasPendingWork(world.queue, world.busy),
          "the queue reports outstanding work at rest, so Publish never unlocks",
        ).toBe(false);
        for (const text of world.owed) {
          const where = placesOf(world, text);
          expect(
            visibleCount(where),
            `${text} settled in ${visibleCount(where)} places, not 1: ${JSON.stringify(where)}`,
          ).toBe(1);
        }
      }),
      { numRuns: 4000 },
    );

    // Ranges over 20 runs at this `numRuns`, recorded per floor. Without these
    // every assertion above is satisfied by interleavings that never got a
    // follow-up out of the queue — which is most of them.
    expect(reached.dispatches, "no follow-up was ever dispatched").toBeGreaterThan(220); // 534-681
    expect(reached.failures, "no turn ever failed").toBeGreaterThan(250); // 605-721
    expect(
      reached.coalescedTurns,
      "no turn's whole lifecycle was ever committed at once",
    ).toBeGreaterThan(300); // 721-820
    expect(
      reached.coalescedOverLatch,
      "no coalesced turn ever landed on an armed latch — the wedge's own state",
    ).toBeGreaterThan(8); // 24-49
    expect(reached.drains, "nothing was ever handed back to the composer").toBeGreaterThan(65); // 162-216
    expect(reached.multiQueued, "two follow-ups never waited together").toBeGreaterThan(190); // 480-709
    expect(reached.stopsMidTurn, "no Stop ever landed on a live turn").toBeGreaterThan(100); // 257-306
    expect(
      reached.settlesInDispatchWindow,
      "no render ever landed inside the dispatch window, where the latch is all that " +
        "stands between the queue and a second concurrent turn",
    ).toBeGreaterThan(1700); // 4106-4323
  });

  test("throws on an unknown event rather than silently doing nothing", () => {
    // The default clause exists to keep the event union and the switch in sync
    // at compile time; reaching it at runtime means the two drifted, and a
    // silent no-op there would look exactly like a queue that is working.
    const world = newWorld();
    // Parsed rather than cast: `as never` is one of the patterns
    // `check-escape-hatches` counts per file, and an event that arrived from
    // outside the type system is what this test is about anyway.
    const unknown: QueueEvent = JSON.parse('{"kind":"nope"}');
    expect(() =>
      runQueueEvent(
        unknown,
        world.queue,
        { status: "ready", busy: false, chatReady: true },
        ioFor(world),
      ),
    ).toThrow(/unhandled queue event/);
  });

  /**
   * The property's own counterexample, frozen.
   *
   * Against the code before the fix this is the whole bug: no error, no Stop,
   * nothing unusual — a follow-up is dispatched and the turn it started opens
   * and closes inside ONE commit, so no render ever reports `busy` and the only
   * release the latch had never fires.
   */
  test("releases the latch when a dispatched turn opens and closes in one commit", () => {
    const label = labeller();
    const world = newWorld();
    world.input = label();
    step(world, { kind: "enter" }, label); //       "<0>" goes out directly
    world.input = label();
    step(world, { kind: "enter" }, label); //       "<1>" joins the queue behind it
    step(world, { kind: "sdkFinishes" }, label); // the turn ends; the effect flushes "<1>"

    expect(world.handedOver, "the follow-up was never dispatched").toBe("<1>");
    expect(world.queue.dispatched, "the dispatch latch was not armed").toBe(true);

    // React commits the whole of that turn at once, so `busy` is never rendered.
    step(world, { kind: "sdkAcceptsAndFinishes" }, label);

    expect(world.transcript, "the follow-up never reached the transcript").toEqual(["<0>", "<1>"]);
    expect(world.queue.dispatched, "the latch outlived the handover that armed it").toBe(false);
    expect(
      hasPendingWork(world.queue, world.busy),
      "the queue still reports work, so Publish stays locked and every submit queues",
    ).toBe(false);
  });
});
