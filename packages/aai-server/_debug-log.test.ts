// Copyright 2025 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debug } from "./_debug-log.ts";

describe("debug logger", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    infoSpy.mockRestore();
    delete process.env.LOG_LEVEL;
  });

  it("emits when LOG_LEVEL=DEBUG", () => {
    process.env.LOG_LEVEL = "DEBUG";
    debug("hello", { a: 1 });
    expect(infoSpy).toHaveBeenCalledWith("hello", { a: 1 });
  });

  it("no-ops otherwise", () => {
    process.env.LOG_LEVEL = "INFO";
    debug("hello");
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
