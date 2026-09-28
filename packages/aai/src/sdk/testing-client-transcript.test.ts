// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test } from "vitest";
import { stepClientTranscript } from "./step-client-transcript.ts";
import { type StubClientTranscript, stubClientTranscript } from "./testing-client-transcript.ts";

let stub: StubClientTranscript | undefined;
afterEach(() => stub?.restore());

const session = (sessionId: string) => ({
  sessionId,
  startedAt: 1,
  lastEventIndex: 0,
  messages: [{ role: "assistant" as const, text: "done", at: 1 }],
  tools: [],
});

describe("stubClientTranscript", () => {
  test("every client has said nothing by default, and each read is recorded", async () => {
    stub = stubClientTranscript();
    await expect(stepClientTranscript("porch", { since: 5 })).resolves.toEqual({ sessions: [] });
    expect(stub.calls).toEqual([{ clientId: "porch", options: { since: 5 } }]);
  });

  test("answers a fixed transcript, or one computed per call", async () => {
    stub = stubClientTranscript(({ clientId }) => ({ sessions: [session(`${clientId}-1`)] }));
    const { sessions } = await stepClientTranscript("porch");
    expect(sessions.map((s) => s.sessionId)).toEqual(["porch-1"]);
  });

  test("restore unpublishes, so a step outside the stub has no reader", async () => {
    stubClientTranscript({ sessions: [session("s")] }).restore();
    await expect(stepClientTranscript("porch")).rejects.toThrow(/no session log/);
  });
});
