// Copyright 2026 the AAI authors. MIT license.
/**
 * The turn-sequence readers, over hand-built turns.
 *
 * No session here on purpose: what these say is a property of a LIST of turns,
 * and the three templates that hand-rolled them could only exercise them by
 * spending a live model. The interesting assertions are the failure MESSAGES —
 * `describeTurn` and `turnCalling`'s throw exist to be read by a human at 2am,
 * and a message is exactly the thing a live eval never checks.
 */

import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import type { EvalToolCall } from "./events.ts";
import type { EvalTurn } from "./session.ts";
import { callsIn, describeTurn, turnCalling } from "./turns.ts";

const call = (name: string, result?: string): EvalToolCall => ({
  toolCallId: `c-${name}`,
  name,
  args: {},
  ...omitUndefined({ result }),
});

/** One turn. `events` is unread by everything here, so it stays empty. */
const turn = (text: string, toolCalls: readonly EvalToolCall[], completed = true): EvalTurn => ({
  text,
  events: [] as readonly SessionEvent[],
  toolCalls,
  completed,
});

const CALL = [
  turn("Let me pull that up.", [call("find_user_id_by_email", '{"id":"u1"}')]),
  turn("I can cancel it — shall I?", [
    call("get_order_details", '{"id":"o1"}'),
    call("cancel_pending_order", '{"state":"awaitingConfirmation"}'),
  ]),
  turn("Done.", [call("cancel_pending_order", '{"state":"cancelled"}')]),
];

describe("describeTurn", () => {
  test("names the tools in order and quotes what was said", () => {
    expect(describeTurn(CALL[0] as EvalTurn)).toBe(
      'called find_user_id_by_email; said "Let me pull that up."',
    );
  });

  test('a turn that acted on nothing reads as "called no tools"', () => {
    expect(describeTurn(turn("What is the order number?", []))).toBe(
      'called no tools; said "What is the order number?"',
    );
  });

  test('a reply with no committed text reads as "said nothing", not a dangling "said:"', () => {
    expect(describeTurn(turn("", [call("stage_change", '{"ok":true}')]))).toBe(
      "called stage_change; said nothing",
    );
  });

  test("a call the runtime never ran says so beside its name", () => {
    // `result: undefined` is what a `tool.called` with no `tool.completed`
    // leaves behind — a tool the agent does not declare, or a turn cut short —
    // and a message that renders it identically to a call that ANSWERED is how
    // a case comes to meet it as a chai type error four lines later.
    expect(describeTurn(turn("", [call("stage_change")]))).toBe(
      "called stage_change (never completed); said nothing",
    );
  });

  test("a CANCELLED reply says so — usually the reason the turn looks empty", () => {
    // `completed` is the one fact that explains a turn which did nothing and
    // said nothing, and it is why this takes an `EvalTurn` rather than a
    // structural `{ text, toolCalls }`.
    expect(describeTurn(turn("", [], false))).toBe(
      "called no tools; said nothing (the reply was cancelled)",
    );
  });

  test("a long reply is elided with its real length, so a cut is not read as an ending", () => {
    const long = "a".repeat(400);
    const described = describeTurn(turn(long, []));
    expect(described).toContain("(400 chars)");
    expect(described).toContain("…");
    // Bounded: this goes on one line beside a stack.
    expect(described.length).toBeLessThan(300);
  });
});

describe("callsIn", () => {
  test("flattens every call across the turns, in order", () => {
    expect(callsIn(CALL).map((c) => c.name)).toEqual([
      "find_user_id_by_email",
      "get_order_details",
      "cancel_pending_order",
      "cancel_pending_order",
    ]);
  });

  test("is empty when no turns were driven", () => {
    expect(callsIn([])).toEqual([]);
  });
});

describe("turnCalling", () => {
  test("answers the FIRST turn the tool was called in, whatever its index", () => {
    // The whole point: the claim is "the turn it staged in", never "turn two".
    expect(turnCalling(CALL, "cancel_pending_order")).toBe(CALL[1]);
    expect(turnCalling(CALL, "find_user_id_by_email")).toBe(CALL[0]);
  });

  test("THROWS naming every turn's tools, rather than answering undefined", () => {
    // The failure the templates' `expect(x, "<hand-built message>").toBeDefined()`
    // pattern existed to produce, and the reason the return type is `EvalTurn`.
    expect(() => turnCalling(CALL, "transfer_to_human_agents")).toThrow(
      /no turn called "transfer_to_human_agents"/,
    );
    expect(() => turnCalling(CALL, "transfer_to_human_agents")).toThrow(
      /turn 1 called find_user_id_by_email; turn 2 called get_order_details, cancel_pending_order/,
    );
  });

  test("no turns at all says so rather than printing an empty shape", () => {
    expect(() => turnCalling([], "anything")).toThrow(/no turns were driven/);
  });

  test("`where` selects the call that did the thing, not merely the name", () => {
    // `travel-concierge`'s `stagingTurn`: the interesting turn is the one whose
    // call STAGED something rather than being refused by the gate.
    const staged = turnCalling(CALL, "cancel_pending_order", (c) =>
      /awaitingConfirmation/.test(c.result ?? ""),
    );
    expect(staged).toBe(CALL[1]);
    expect(
      turnCalling(CALL, "cancel_pending_order", (c) => /"cancelled"/.test(c.result ?? "")),
    ).toBe(CALL[2]);
  });

  test("called but unmatched is a DIFFERENT finding from never called", () => {
    // Only one of the two is about the agent ignoring the tool.
    expect(() => turnCalling(CALL, "cancel_pending_order", () => false)).toThrow(
      /2 call\(s\) to "cancel_pending_order" and none matched the predicate/,
    );
  });
});
