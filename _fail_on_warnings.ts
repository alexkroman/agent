import { afterEach, beforeEach, expect, vi } from "vitest";

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let expectWarnings: boolean;
let expectErrors: boolean;

beforeEach(() => {
  expectWarnings = false;
  expectErrors = false;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  const warnCalls = warnSpy.mock.calls;
  const errorCalls = errorSpy.mock.calls;
  warnSpy.mockRestore();
  errorSpy.mockRestore();

  if (warnCalls.length > 0 && !expectWarnings) {
    expect.unreachable(
      `Unexpected console.warn (${warnCalls.length}):\n${warnCalls.map((a: unknown[]) => `  ${a.join(" ")}`).join("\n")}\nSuppress with vi.spyOn(console, "warn") in the test.`,
    );
  }
  if (errorCalls.length > 0 && !expectErrors) {
    expect.unreachable(
      `Unexpected console.error (${errorCalls.length}):\n${errorCalls.map((a: unknown[]) => `  ${a.join(" ")}`).join("\n")}\nSuppress with vi.spyOn(console, "error") in the test.`,
    );
  }
});

/**
 * Call in a test to suppress console.warn failure for that test.
 * Usage: `expectConsoleWarnings();`
 */
export function expectConsoleWarnings() {
  expectWarnings = true;
}

/**
 * Call in a test to suppress console.error failure for that test.
 * Usage: `expectConsoleErrors();`
 */
export function expectConsoleErrors() {
  expectErrors = true;
}
