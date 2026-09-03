// Copyright 2026 the AAI authors. MIT license.
/**
 * `SessionCore`'s conversation: what a restore puts back, and who it reaches.
 *
 * Split out of `session-core.test.ts` at the 700-line test cap, on the seam that
 * file already had (`describe("createSessionCore — history")`). It is a real
 * seam rather than a convenient cut: every case here is about the CONVERSATION —
 * the model's copy of it, the client's, and the retained log — where the suite
 * next door is about the session's lifecycle and its inbound surfaces.
 */

import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { makeCore } from "./_session-core-harness.ts";

describe("createSessionCore — history", () => {
  // History is private state, but it is not unobservable: every tool call is
  // handed a snapshot of it (`executeTool`'s 4th argument), which is the same
  // view the agent's own tools get. Asserting through that seam is what makes
  // "appends" and "pushes" claims rather than a sequence of calls that merely
  // did not throw.
  test("restoreHistory appends and onUserTranscript pushes user messages", async () => {
    const executeTool = vi.fn<ExecuteTool>(async () => "ok");
    const { core } = makeCore({ executeTool });
    await core.start();

    core.restoreHistory([{ role: "user", content: "prior" }]);
    core.report({ type: "user-transcript.committed", text: "now" });

    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "c1", toolName: "lookup", args: {} });
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());
    expect(executeTool.mock.calls[0]?.[3]).toEqual([
      { role: "user", content: "prior" },
      { role: "user", content: "now" },
    ]);
  });

  test("restoreHistory SENDS the conversation to the client", async () => {
    // The half that was missing. Everything else `restoreHistory` does restores
    // the conversation for the MODEL — and the browser, which had stopped
    // replaying its own on the grounds that the server now owned this, rendered
    // an empty transcript beside an agent that remembered every word.
    const { core, sink } = makeCore();
    await core.start();

    core.restoreHistory([
      { role: "user", content: "two large pepperoni" },
      { role: "assistant", content: "Got it." },
    ]);

    const sent = sink.events.filter((e: SessionEvent) => e.type === "history.restored");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      messages: [
        { role: "user", content: "two large pepperoni" },
        { role: "assistant", content: "Got it." },
      ],
    });
    // Stamped like any other event, because the client parses one schema.
    expect(sent[0]?.meta.id).toMatch(/^evt_/);
  });

  test("it is NOT recorded, or a resume would double its own log", async () => {
    // Sent through the SINK rather than emitted: the emitter records first, so
    // emitting the history just read out of the log appends it straight back —
    // once per resume, unboundedly.
    const { core, stream } = makeCore();
    await core.start();
    const tailBefore = stream.tail("s-test");

    core.restoreHistory([{ role: "user", content: "prior" }]);

    // The LOG did not grow, while the client did receive the frame.
    expect(stream.tail("s-test")).toBe(tailBefore);
  });

  test("a resume with nothing to show sends no frame", async () => {
    // `tool` messages are in the model's context and are not rendered, so a
    // restore made entirely of them has nothing for a client to display — and an
    // empty frame would clear a transcript rather than restore one.
    const { core, sink } = makeCore();
    await core.start();

    core.restoreHistory([{ role: "tool", content: '{"ok":true}' }]);

    expect(sink.events.filter((e: SessionEvent) => e.type === "history.restored")).toHaveLength(0);
  });

  test("a RECOVERY phrase never reaches the model's context", async () => {
    // `speakRecovery` reports a committed transcript so the CAPTION matches what
    // the caller heard, and `pipeline-turn-outcome.ts`'s own table says that
    // phrase reaches "history / ctx.messages: never" — while this dispatch
    // pushed it, on the same call, into the very array every tool call is handed.
    const executeTool = vi.fn<ExecuteTool>(async () => "ok");
    const { core } = makeCore({ executeTool });
    await core.start();

    core.report({ type: "user-transcript.committed", text: "hi" });
    core.report({
      type: "agent-transcript.committed",
      text: "Sorry, I had a problem just then.",
      recovery: "turn-failed",
    });
    core.report({ type: "agent-transcript.committed", text: "Here you go." });

    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "c1", toolName: "lookup", args: {} });
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());
    expect(executeTool.mock.calls[0]?.[3]).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Here you go." },
    ]);
  });

  test("the phrase is still EMITTED, because the caller heard it", async () => {
    // The other half, and the reason the fix cannot be "stop reporting it": the
    // client's transcript must match the audio, so the event goes out — tag and
    // all, since a client may want to render a recovery line differently.
    const { core, sink } = makeCore();
    await core.start();

    core.report({
      type: "agent-transcript.committed",
      text: "Sorry, I had a problem just then.",
      recovery: "turn-failed",
    });

    expect(
      sink.events.filter((e: SessionEvent) => e.type === "agent-transcript.committed"),
    ).toMatchObject([{ text: "Sorry, I had a problem just then.", recovery: "turn-failed" }]);
  });

  test("onReset clears the history the next tool call sees", async () => {
    const executeTool = vi.fn<ExecuteTool>(async () => "ok");
    const { core } = makeCore({ executeTool });
    await core.start();
    core.restoreHistory([{ role: "user", content: "prior" }]);

    core.command({ type: "reset" });

    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "c1", toolName: "lookup", args: {} });
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());
    expect(executeTool.mock.calls[0]?.[3]).toEqual([]);
  });
});
