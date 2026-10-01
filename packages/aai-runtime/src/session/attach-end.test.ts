// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "../_logger-test-utils.ts";
import { makeClientSink } from "../_session-test-utils.ts";
import { closeRefused, endOnRequest, SessionRefusedError } from "./attach-end.ts";

describe("SessionRefusedError", () => {
  test("carries the app's reason, and is an Error a catch can tell apart", () => {
    const err = new SessionRefusedError("not a placed call");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionRefusedError");
    expect(err.reason).toBe("not a placed call");
  });
});

describe("closeRefused", () => {
  test("uses the adapter's close when it has one, the client's otherwise", () => {
    const client = makeClientSink({ close: vi.fn() });
    const closeAfterRefusal = vi.fn();
    closeRefused("stranger", { client, options: { closeAfterRefusal }, log: makeLogger() });
    expect(closeAfterRefusal).toHaveBeenCalledWith("stranger");
    expect(client.close).not.toHaveBeenCalled();

    closeRefused("stranger", { client, options: {}, log: makeLogger() });
    expect(client.close).toHaveBeenCalledWith("stranger");
  });

  test("a close that throws is logged, never thrown", () => {
    const log = makeLogger();
    const closeAfterRefusal = () => {
      throw new Error("socket already gone");
    };
    expect(() =>
      closeRefused("x", { client: makeClientSink(), options: { closeAfterRefusal }, log }),
    ).not.toThrow();
    expect(log.debug).toHaveBeenCalled();
  });
});

describe("endOnRequest", () => {
  test("ends once, however many times a tool asks, and logs the request", () => {
    const client = makeClientSink({ close: vi.fn() });
    const closeOnEndSession = vi.fn();
    const log = makeLogger();
    const end = endOnRequest({
      client,
      options: { closeOnEndSession },
      log,
      ctx: { transport: "phone" },
      sid: "abcd1234",
    });
    end({ afterReply: true });
    end({ afterReply: false });
    expect(closeOnEndSession).toHaveBeenCalledTimes(1);
    expect(closeOnEndSession).toHaveBeenCalledWith({ afterReply: true });
    expect(log.info).toHaveBeenCalledWith(
      "Session ending at a tool's request",
      expect.objectContaining({ transport: "phone", sid: "abcd1234", afterReply: true }),
    );
  });

  test("without an adapter close, the client is closed at once", () => {
    const client = makeClientSink({ close: vi.fn() });
    endOnRequest({ client, options: {}, log: makeLogger(), ctx: {}, sid: "s" })({
      afterReply: true,
    });
    expect(client.close).toHaveBeenCalledWith("session ended by the agent");
  });
});
