// Copyright 2025 the AAI authors. MIT license.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { debug } from "./_debug-log.ts";

describe("debug logger", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  it("emits when LOG_LEVEL=DEBUG", () => {
    vi.stubEnv("LOG_LEVEL", "DEBUG");
    debug("hello", { a: 1 });
    expect(infoSpy).toHaveBeenCalledWith("hello", { a: 1 });
  });

  it("no-ops otherwise", () => {
    vi.stubEnv("LOG_LEVEL", "INFO");
    debug("hello");
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
