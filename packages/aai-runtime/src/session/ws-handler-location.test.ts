// Copyright 2026 the AAI authors. MIT license.
// wireSessionSocket records a client-reported `?location=` (and `?phone=`) under
// the session's id before the session is built, where builtins and tools read it.

import { sessionClientPhone } from "@alexkroman1/aai";
import { getSessionLocation } from "@alexkroman1/aai/host-internal";

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { makeMockCore, silentLogger } from "../_test-utils.ts";
import { defaultConfig, openSocket } from "./_ws-handler-test-utils.ts";
import { createSessionDirectory } from "./directory.ts";
import { wireSessionSocket } from "./ws-handler.ts";

describe("wireSessionSocket client location", () => {
  test("is recorded under the session id before the session is created", () => {
    let seenAtCreate: string | undefined;
    wireSessionSocket(openSocket(), {
      sessions: createSessionDirectory(),
      createSession: (sid) => {
        seenAtCreate = getSessionLocation({ sessionId: sid });
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "located-session",
      clientLocation: "123 Example St, Portland, OR 97201",
    });
    expect(seenAtCreate).toBe("123 Example St, Portland, OR 97201");
  });

  test("a resume without a location keeps the one reported before", () => {
    const open = (clientLocation?: string) =>
      wireSessionSocket(openSocket(), {
        sessions: createSessionDirectory(),
        createSession: () => makeMockCore(),
        readyConfig: defaultConfig,
        logger: silentLogger,
        resumeFrom: "resumed-located",
        ...omitUndefined({ clientLocation }),
      });
    open("1 First Ave, Springfield, IL");
    open();
    expect(getSessionLocation({ sessionId: "resumed-located" })).toBe(
      "1 First Ave, Springfield, IL",
    );
  });
});

describe("wireSessionSocket client phone", () => {
  const open = (sessionId: string, clientPhone?: string, seen?: (sid: string) => void) =>
    wireSessionSocket(openSocket(), {
      sessions: createSessionDirectory(),
      createSession: (sid) => {
        seen?.(sid);
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: sessionId,
      ...omitUndefined({ clientPhone }),
    });

  test("is recorded under the session id before the session is created", () => {
    let seenAtCreate: string | undefined;
    open("phoned-session", "+15035550123", (sid) => {
      seenAtCreate = sessionClientPhone({ sessionId: sid });
    });
    expect(seenAtCreate).toBe("+15035550123");
  });

  test("a resume without a phone keeps the one reported before", () => {
    open("resumed-phoned", "+15035550123");
    open("resumed-phoned");
    expect(sessionClientPhone({ sessionId: "resumed-phoned" })).toBe("+15035550123");
  });
});
