// Copyright 2026 the AAI authors. MIT license.
/**
 * The failing-try transcript: what it shows, and where it stops.
 *
 * Two properties are worth pinning. It shows each tool call WITH its arguments
 * and result under the turn that made it (the part a first-line summary lost),
 * and it is BOUNDED — per field and in total — so one runaway case cannot bury
 * the rest of a summary.
 */

import type { SessionEvent } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { evalNetwork } from "./network.ts";
import { clip, transcriptOf } from "./transcript.ts";

const meta = { id: "e1", at: 0 };

/** A session over a fixed event list. */
function sessionOf(events: readonly SessionEvent[]) {
  return { events: () => events };
}

const user = (text: string): SessionEvent => ({ type: "userTranscript.committed", meta, text });
const agentSaid = (text: string): SessionEvent => ({
  type: "agentTranscript.committed",
  meta,
  text,
});
const called = (id: string, name: string, args: Record<string, unknown>): SessionEvent => ({
  type: "tool.called",
  meta,
  toolCallId: id,
  toolName: name,
  args,
});
const completed = (id: string, result: string): SessionEvent => ({
  type: "tool.completed",
  meta,
  toolCallId: id,
  result,
});

describe("transcriptOf", () => {
  test("lines in order, each tool call with its args and result beneath its turn", () => {
    const text = transcriptOf(
      sessionOf([
        agentSaid("Hi, how can I help?"),
        user("Book a table for four."),
        called("c1", "book", { party: 4 }),
        completed("c1", '{"booked":true}'),
        called("c2", "text_me", {}),
        agentSaid("Booked for four."),
      ]),
    );
    expect(text).toBe(
      [
        "Agent: Hi, how can I help?",
        "User: Book a table for four.",
        '  [book({"party":4}) -> {"booked":true}]',
        "  [text_me({}) (never completed)]",
        "Agent: Booked for four.",
      ].join("\n"),
    );
  });

  test("a long argument and a long result are each cut, the cut named", () => {
    const text = transcriptOf(
      sessionOf([
        called("c1", "save", { note: "x".repeat(500) }),
        completed("c1", "y".repeat(500)),
      ]),
    );
    expect(text).toMatch(/\(511 chars\)\) -> y{200}… \(500 chars\)\]$/);
  });

  test("past the line budget it keeps the TAIL, and says what it dropped", () => {
    const events = Array.from({ length: 50 }, (_, i) => user(`line ${i}`));
    const lines = transcriptOf(sessionOf(events)).split("\n");
    expect(lines[0]).toBe("(10 earlier line(s) omitted)");
    expect(lines.at(-1)).toBe("User: line 49");
    expect(lines).toHaveLength(41);
  });

  test("the network's refused requests follow — the host the agent reached for", async () => {
    const network = evalNetwork();
    await network.fetch("https://api.twilio.com/Calls", { method: "POST" }).catch(() => undefined);
    const text = transcriptOf(sessionOf([]), network);
    expect(text).toBe(
      "refused by the eval network (1):\n  POST https://api.twilio.com/Calls (refused)",
    );
  });

  test("a request a builtin retried is one refusal with a count, not two lines", async () => {
    const network = evalNetwork();
    for (let i = 0; i < 2; i += 1) {
      await network
        .fetch("https://api.twilio.com/Calls", { method: "POST" })
        .catch(() => undefined);
    }
    expect(transcriptOf(sessionOf([]), network)).toBe(
      "refused by the eval network (2):\n  POST https://api.twilio.com/Calls (refused) ×2",
    );
  });

  test("a session that said nothing says so, rather than printing an empty block", () => {
    expect(transcriptOf(sessionOf([]))).toBe("(nothing was said)");
  });
});

describe("clip", () => {
  test("leaves a short string alone and names the length of a cut one", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("abcdefghij", 4)).toBe("abcd… (10 chars)");
  });
});
