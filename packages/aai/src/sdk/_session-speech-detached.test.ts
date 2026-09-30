// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { DETACHED_SESSION_SPEECH } from "./_session-speech-detached.ts";

describe("DETACHED_SESSION_SPEECH", () => {
  test("answers as an ended session: every line DROPPED, interrupt false", async () => {
    const handle = DETACHED_SESSION_SPEECH.say("Hello?", { interrupt: true });
    await expect(handle.done).resolves.toBe("dropped");
    expect(() => handle.interrupt()).not.toThrow();
    expect(DETACHED_SESSION_SPEECH.interrupt()).toBe(false);
  });

  test("is frozen, so no context can swap a live method into the shared one", () => {
    expect(Object.isFrozen(DETACHED_SESSION_SPEECH)).toBe(true);
  });
});
