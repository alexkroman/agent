// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { FatalError, RetryableError } from "./step-error-classes.ts";
import {
  CLIENT_INBOX_UNAVAILABLE_MESSAGE,
  type ClientNotifier,
  ClientUnreachableError,
  DEFAULT_CLIENT_ACK_TIMEOUT_MS,
  publishClientNotifier,
  stepNotifyClient,
} from "./step-notify-client.ts";

afterEach(() => publishClientNotifier(undefined));

describe("stepNotifyClient", () => {
  test("resolves when the client acks, handing the notifier the notice and the ack budget", async () => {
    const notify = vi.fn<ClientNotifier>(async () => "acked");
    publishClientNotifier(notify);
    const audio = new Uint8Array([1, 2, 3]);
    await stepNotifyClient("speaker", { id: "run-1", event: "reminder", audio });
    expect(notify).toHaveBeenCalledWith(
      "speaker",
      { id: "run-1", event: "reminder", audio },
      { ackTimeoutMs: DEFAULT_CLIENT_ACK_TIMEOUT_MS, signal: undefined },
    );
  });

  test.each(["offline", "busy", "no-ack", "disconnected"] as const)(
    "a notice not taken (%s) is a RETRYABLE failure, due after retryAfterMs",
    async (reason) => {
      publishClientNotifier(async () => reason);
      const before = Date.now();
      const err = await stepNotifyClient(
        "speaker",
        { id: "r", event: "e" },
        { retryAfterMs: 5000 },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ClientUnreachableError);
      expect(err).toBeInstanceOf(RetryableError);
      expect(err).toMatchObject({ reason, clientId: "speaker" });
      const due = (err as ClientUnreachableError).retryAfter.getTime();
      expect(due).toBeGreaterThanOrEqual(before + 5000);
    },
  );

  test("with nothing published it is FATAL, naming the fix — retrying cannot conjure an inbox", async () => {
    const err = await stepNotifyClient("speaker", { id: "r", event: "e" }).catch((e) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect(err.message).toBe(CLIENT_INBOX_UNAVAILABLE_MESSAGE);
  });

  test("a malformed client id or notice id is refused before anything is sent", async () => {
    const notify = vi.fn<ClientNotifier>(async () => "acked");
    publishClientNotifier(notify);
    await expect(stepNotifyClient("a b", { id: "r", event: "e" })).rejects.toBeInstanceOf(
      FatalError,
    );
    await expect(stepNotifyClient("ok", { id: "", event: "e" })).rejects.toBeInstanceOf(FatalError);
    await expect(
      stepNotifyClient("ok", { id: "x".repeat(129), event: "e" }),
    ).rejects.toBeInstanceOf(FatalError);
    expect(notify).not.toHaveBeenCalled();
  });

  test("a notifier that throws (an aborted step) propagates unchanged", async () => {
    const boom = new Error("aborted");
    publishClientNotifier(async () => {
      throw boom;
    });
    await expect(stepNotifyClient("speaker", { id: "r", event: "e" })).rejects.toBe(boom);
  });
});
