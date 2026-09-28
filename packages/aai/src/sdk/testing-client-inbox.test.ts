// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test } from "vitest";
import { ClientUnreachableError, stepNotifyClient } from "./step-notify-client.ts";
import { type StubClientInbox, stubClientInbox } from "./testing-client-inbox.ts";

let inbox: StubClientInbox | undefined;
afterEach(() => inbox?.restore());

describe("stubClientInbox", () => {
  test("records each notice a step pushes and acks it by default", async () => {
    inbox = stubClientInbox();
    const audio = new Uint8Array(4);
    await stepNotifyClient("porch", { id: "r", event: "reminder", audio });
    expect(inbox.calls).toEqual([
      { clientId: "porch", notice: { id: "r", event: "reminder", audio } },
    ]);
  });

  test("answers as told, per call when a function: busy once, then acked", async () => {
    let n = 0;
    inbox = stubClientInbox({ answer: () => (n++ === 0 ? "busy" : "acked") });
    const first = await stepNotifyClient("porch", { id: "r", event: "e" }).catch((e) => e);
    expect(first).toBeInstanceOf(ClientUnreachableError);
    expect(first).toMatchObject({ reason: "busy" });
    await stepNotifyClient("porch", { id: "r", event: "e" });
    expect(inbox.calls).toHaveLength(2);
  });

  test("restore unpublishes, so a step outside the stub has no inbox", async () => {
    stubClientInbox().restore();
    await expect(stepNotifyClient("porch", { id: "r", event: "e" })).rejects.toThrow(
      /no client inbox/,
    );
  });
});
