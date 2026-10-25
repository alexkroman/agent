// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { mintSessionId, setSessionIdMinter } from "./session-id.ts";

afterEach(() => setSessionIdMinter(undefined));

describe("mintSessionId", () => {
  test("is a random UUID by default", () => {
    const a = mintSessionId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(mintSessionId()).not.toBe(a);
  });

  test("uses the installed minter, and undefined restores the default", () => {
    setSessionIdMinter(() => "worker-3-id");
    expect(mintSessionId()).toBe("worker-3-id");
    setSessionIdMinter(undefined);
    expect(mintSessionId()).not.toBe("worker-3-id");
  });
});
