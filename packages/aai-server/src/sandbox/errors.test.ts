// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { SandboxUnavailableError } from "./errors.ts";

describe("SandboxUnavailableError", () => {
  test("is an Error with its own name, message and cause", () => {
    const cause = new Error("no capacity");
    const err = new SandboxUnavailableError("spawn failed", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SandboxUnavailableError);
    expect(err.name).toBe("SandboxUnavailableError");
    expect(err.message).toBe("spawn failed");
    expect(err.cause).toBe(cause);
  });
});
