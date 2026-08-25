import { describe, expect, test } from "vitest";
import type { Transport, TransportCallbacks, TransportEventBody } from "./types.ts";

// This file used to hold one `test("file compiles")` whose whole assertion was
// `toBeDefined()` on a literal declared two lines above, plus a dead
// `type _CB`. The only real check was the type annotation, which `tsc` already
// performs — and its presence made the transport contract LOOK covered by the
// unit suite. What is actually worth pinning here is the runtime half of the
// contract that a type annotation cannot state.

describe("Transport contract", () => {
  test("every verb is present and the two lifecycle verbs are thenable", async () => {
    // A `Transport` is driven by session-core through these five names only, so
    // an implementation that renamed one type-checks at its own definition and
    // fails at the call site. `start`/`stop` are awaited on every path.
    const calls: string[] = [];
    const stub: Transport = {
      start: () => {
        calls.push("start");
        return Promise.resolve();
      },
      stop: () => {
        calls.push("stop");
        return Promise.resolve();
      },
      sendUserAudio: () => calls.push("sendUserAudio"),
      sendToolResult: () => calls.push("sendToolResult"),
      cancelReply: () => calls.push("cancelReply"),
    };

    await stub.start();
    stub.sendUserAudio(new Uint8Array([1, 2]));
    stub.sendToolResult("call-1", "{}");
    stub.cancelReply();
    await stub.stop();

    expect(calls).toEqual(["start", "sendUserAudio", "sendToolResult", "cancelReply", "stop"]);
  });

  test("report() carries the whole event, so a handler can switch on `type`", () => {
    // `TransportCallbacks.report` is the single fan-in every transport reports
    // through, and the discriminant is what makes one handler serve fourteen
    // event kinds. Pinned at runtime because a body that lost its `type` would
    // still satisfy any per-event annotation written against it.
    const seen: TransportEventBody[] = [];
    const callbacks: TransportCallbacks = {
      report: (event) => seen.push(event),
      onReplyStarted: () => undefined,
      onAudioChunk: () => undefined,
    };

    callbacks.report({ type: "user-transcript.committed", text: "hi" });
    callbacks.report({ type: "reply.cancelled" });

    expect(seen.map((e) => e.type)).toEqual(["user-transcript.committed", "reply.cancelled"]);
    expect(seen[0]).toEqual({ type: "user-transcript.committed", text: "hi" });
  });
});
