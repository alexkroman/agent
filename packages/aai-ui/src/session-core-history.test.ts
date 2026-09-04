// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * `history.restored` — what a RESUME puts back on screen.
 *
 * Split out of `session-core-messaging.test.ts` at the 700-line test cap, on the
 * seam that file already had. It is a real seam: every case here is about the
 * frame that carries a conversation back to a client, where the suite next door
 * is about parsing, sending, and the socket lifecycle.
 *
 * The property the whole file rests on: the server is AUTHORITATIVE about a
 * resumed conversation, and the client mints its own render keys. So the frame
 * REPLACES both lists, and a tool call's anchor arrives as an index into the same
 * frame's messages rather than as an id.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lastSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createBrowserSession } from "./session-core.ts";
import type { BrowserSession } from "./session-core-types.ts";

describe("createBrowserSession", () => {
  let core: BrowserSession;

  beforeEach(() => {
    resetLastSocket();
    // Each test is a fresh TAB: a stored session id survives a reload, which
    // inside one jsdom document means it survives between tests.
    sessionStorage.clear();
    core = createBrowserSession({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocketConstructor,
    });
  });

  afterEach(() => {
    core.disconnect();
  });

  describe("history.restored", () => {
    /** Connect and hand the client a config frame, as a resume does. */
    function connected() {
      core.connect();
      lastSocket?.simulateOpen();
      lastSocket?.simulateMessage(makeConfig());
      return lastSocket;
    }

    it("populates the transcript a resumed session cannot see otherwise", () => {
      // The whole point: a page RELOAD builds a fresh core with no messages, and
      // the server's retained log is the only copy left.
      const socket = connected();
      expect(core.getSnapshot().messages).toHaveLength(0);

      socket?.simulateMessage(
        JSON.stringify({
          type: "history.restored",
          messages: [
            { role: "user", content: "two large pepperoni" },
            { role: "assistant", content: "Got it." },
          ],
          toolCalls: [],
        }),
      );

      expect(core.getSnapshot().messages).toEqual([
        { id: 1, role: "user", content: "two large pepperoni" },
        { id: 2, role: "assistant", content: "Got it." },
      ]);
    });

    it("REPLACES rather than appends, so a second delivery cannot double it", () => {
      // A reconnect can restore twice — once per connection — and the server is
      // authoritative about the conversation either way.
      const socket = connected();
      const frame = JSON.stringify({
        type: "history.restored",
        messages: [{ role: "user", content: "only once" }],
        toolCalls: [],
      });
      socket?.simulateMessage(frame);
      socket?.simulateMessage(frame);
      expect(core.getSnapshot().messages).toEqual([{ id: 1, role: "user", content: "only once" }]);
    });

    it("keeps ids unique for messages spoken AFTER the restore", () => {
      // The ids are render keys, so a restored message and a live one colliding
      // would have React reuse a row for different content.
      const socket = connected();
      socket?.simulateMessage(
        JSON.stringify({
          type: "history.restored",
          messages: [{ role: "user", content: "prior" }],
          toolCalls: [],
        }),
      );
      socket?.simulateMessage(JSON.stringify({ type: "user-transcript.committed", text: "now" }));
      const ids = core.getSnapshot().messages.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("restores tool calls anchored to the message they followed", () => {
      // The interleaving is the whole point: a flat list would render every tool
      // row in one clump instead of inside the conversation. The wire carries an
      // INDEX and the client resolves it to the id it just minted.
      const socket = connected();
      socket?.simulateMessage(
        JSON.stringify({
          type: "history.restored",
          messages: [
            { role: "user", content: "where is order 4471" },
            { role: "assistant", content: "Tuesday." },
          ],
          toolCalls: [
            {
              callId: "c1",
              name: "lookup_order",
              args: { id: "4471" },
              status: "done",
              result: '{"eta":"tue"}',
              afterMessageIndex: 0,
            },
          ],
        }),
      );

      const snap = core.getSnapshot();
      expect(snap.messages.map((m) => m.id)).toEqual([1, 2]);
      // Anchored to the FIRST message's minted id — the user turn it followed —
      // so it renders between the question and the answer.
      expect(snap.toolCalls).toEqual([
        {
          callId: "c1",
          name: "lookup_order",
          args: { id: "4471" },
          status: "done",
          result: '{"eta":"tue"}',
          seq: 1,
          afterMessageId: 1,
        },
      ]);
    });

    it("an anchor of -1 renders ahead of the transcript rather than vanishing", () => {
      // Two ways to get here: a call that preceded any message, and one whose
      // anchor the server's own window slid past. Both mean "before all messages",
      // which is the sentinel the live path already uses.
      const socket = connected();
      socket?.simulateMessage(
        JSON.stringify({
          type: "history.restored",
          messages: [{ role: "assistant", content: "Working on it." }],
          toolCalls: [
            {
              callId: "c9",
              name: "charge_card",
              args: {},
              status: "pending",
              afterMessageIndex: -1,
            },
          ],
        }),
      );
      const [call] = core.getSnapshot().toolCalls;
      expect(call?.afterMessageId).toBe(-1);
      // Pending survives the restore: it may really have been in flight.
      expect(call?.status).toBe("pending");
      expect(call?.result).toBeUndefined();
    });

    it("bumps contentVersion, so a subscriber re-renders", () => {
      // `contentVersion` is what `useSession` selectors key off — a restore that
      // did not bump it would populate the snapshot and leave the UI blank, which
      // is the bug this frame exists to fix, one layer up.
      const socket = connected();
      const before = core.getSnapshot().contentVersion;
      socket?.simulateMessage(
        JSON.stringify({
          type: "history.restored",
          messages: [{ role: "assistant", content: "restored" }],
          toolCalls: [],
        }),
      );
      expect(core.getSnapshot().contentVersion).toBeGreaterThan(before);
    });
  });
});
