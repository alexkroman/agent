// Copyright 2025 the AAI authors. MIT license.

import { render } from "preact";
import { describe, expect, test } from "vitest";
import { delay, flush, getContainer, setupDOM, withSignalsEnv } from "./_test_utils.ts";
import { useSession } from "./signals.ts";

describe("createSessionControls", () => {
  test(
    "has correct defaults",
    withSignalsEnv(({ signals }) => {
      expect(signals.session.state.value).toBe("disconnected");
      expect(signals.session.messages.value).toEqual([]);
      expect(signals.session.userUtterance.value).toBe(null);
      expect(signals.session.error.value).toBe(null);
      expect(signals.started.value).toBe(false);
      expect(signals.running.value).toBe(true);
    }),
  );

  test(
    "sets running to false on error state",
    withSignalsEnv(async ({ signals, connect, send, session }) => {
      await connect();
      expect(signals.running.value).toBe(true);
      send({ type: "error", code: "internal", message: "fatal" });
      expect(signals.running.value).toBe(false);
      session.disconnect();
    }),
  );

  test(
    "start() sets started/running and connects",
    withSignalsEnv(async ({ mock, signals, session }) => {
      expect(signals.started.value).toBe(false);
      signals.start();
      await flush();

      expect(signals.started.value).toBe(true);
      expect(signals.running.value).toBe(true);
      expect(mock.lastWs !== null).toBe(true);
      session.disconnect();
    }),
  );

  test(
    "toggle() disconnects then reconnects",
    withSignalsEnv(async ({ signals, session }) => {
      signals.start();
      await flush();

      signals.toggle();
      expect(signals.running.value).toBe(false);

      signals.toggle();
      await flush();
      expect(signals.running.value).toBe(true);
      session.disconnect();
    }),
  );

  test(
    "reset() sends reset message",
    withSignalsEnv(async ({ mock, signals, connect, session }) => {
      await connect();

      const before = mock.lastWs!.sent.length;
      signals.reset();

      const sent = mock
        .lastWs!.sent.slice(before)
        .filter((d): d is string => typeof d === "string");
      expect(sent.some((s) => JSON.parse(s).type === "reset")).toBe(true);
      session.disconnect();
    }),
  );
});

describe("useSession", () => {
  test("throws outside SessionProvider", async () => {
    setupDOM();
    const container = getContainer();

    function Orphan() {
      useSession();
      return <div />;
    }

    let caught: Error | null = null;
    try {
      render(<Orphan />, container);
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).not.toBe(null);
    expect(caught!.message).toContain("Hook useSession() requires a SessionProvider");

    render(null, container);
    await delay(0);
  });
});
