// Copyright 2026 the AAI authors. MIT license.
// The S2S server-message vocabulary (`parseS2sMessage`): the aliases it
// accepts, the defaults it fills, and the frames it refuses — plus the one
// connectS2s case that shows a refused frame is logged and dropped rather than
// dispatched.

import { describe, expect, test } from "vitest";
import { emitMessage, setupHandle } from "./_s2s-test-utils.ts";
import { parseS2sMessage } from "./messages.ts";

describe("parseS2sMessage", () => {
  test("tool.call reads `arguments`, falls back to `args`, and defaults to {}", () => {
    expect(
      parseS2sMessage({
        type: "tool.call",
        call_id: "c1",
        name: "n",
        arguments: { a: 1 },
        args: { b: 2 },
      }),
    ).toEqual({ type: "tool.call", call_id: "c1", name: "n", args: { a: 1 } });
    expect(
      parseS2sMessage({ type: "tool.call", call_id: "c1", name: "n", args: { b: 2 } }),
    ).toEqual({
      type: "tool.call",
      call_id: "c1",
      name: "n",
      args: { b: 2 },
    });
    expect(parseS2sMessage({ type: "tool.call", call_id: "c1", name: "n" })).toMatchObject({
      args: {},
    });
  });

  test("the transcript deltas accept either field name", () => {
    expect(parseS2sMessage({ type: "transcript.user.delta", delta: "wha" })).toEqual({
      type: "transcript.user.delta",
      text: "wha",
    });
    expect(parseS2sMessage({ type: "transcript.agent.delta", text: "word" })).toEqual({
      type: "transcript.agent.delta",
      text: "word",
    });
  });

  test("transcript.agent fills its optional fields", () => {
    expect(parseS2sMessage({ type: "transcript.agent", text: "Hi." })).toEqual({
      type: "transcript.agent",
      text: "Hi.",
      reply_id: "",
      item_id: "",
      interrupted: false,
    });
  });

  test.each([
    [{ type: "totally.unknown.type" }],
    [{ type: "reply.started" }],
    [{ type: "tool.call", call_id: "x" }],
    [{ type: "transcript.user", item_id: 7, text: null }],
    [{}],
  ])("refuses %j", (frame) => {
    expect(parseS2sMessage(frame)).toBeUndefined();
  });
});

describe("connectS2s", () => {
  test("unrecognized message type is logged and ignored", async () => {
    const { raw, logger } = await setupHandle();

    emitMessage(raw, { type: "totally.unknown.type" });

    expect(logger.warn).toHaveBeenCalled();
  });
});
