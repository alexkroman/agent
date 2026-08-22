// Copyright 2026 the AAI authors. MIT license.
// Injected-turn specs: `injectTurn` makes the agent speak with nobody having
// said anything — the verb a durable run finishing needs (see
// `host/workflow-notify.ts`). The instruction reaches the LLM as a user
// message and is never surfaced as a user transcript, exactly as the silence
// nudge's prompt is.

import { describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { makeOpts, useVirtualTime } from "./_pipeline-transport-harness.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

useVirtualTime();

describe("injectTurn", () => {
  test("takes a turn from an instruction nobody spoke", async () => {
    const llm = createFakeLanguageModel({
      script: [{ type: "text", text: "Your research is done — tulips were mostly fine." }],
    });
    const { opts, callbacks } = makeOpts({ llm });
    const t = createPipelineTransport(opts);
    await t.start();

    t.injectTurn?.("The research you started has finished. Tell the caller.");

    await vi.waitFor(() => {
      expect(callbacks.reported("reply.completed")).toHaveBeenCalled();
    });
    expect(JSON.stringify(llm.calls[0]?.prompt)).toContain("has finished");
    // Never a user transcript: nobody said this, and a client rendering it as
    // the caller's own words would be a lie about the conversation.
    expect(callbacks.reported("user-transcript.committed")).not.toHaveBeenCalled();
    expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: "Your research is done — tulips were mostly fine.",
    });
    await t.stop();
  });

  test("says nothing once the transport has stopped", async () => {
    const llm = createFakeLanguageModel({ script: [{ type: "text", text: "too late" }] });
    const { opts } = makeOpts({ llm });
    const t = createPipelineTransport(opts);
    await t.start();
    await t.stop();

    t.injectTurn?.("The research you started has finished.");
    await vi.advanceTimersByTimeAsync(50);

    // A run that lands while the caller is hanging up is the ordinary race,
    // and the answer is silence rather than a turn on a dead session.
    expect(llm.calls).toHaveLength(0);
  });
});
