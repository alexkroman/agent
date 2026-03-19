import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./cli.ts";

describe("cli main", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let _errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    _errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("--version prints version and returns", async () => {
    await main(["--version"]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(typeof logSpy.mock.calls[0][0]).toBe("string");
    // Version should be a semver-like string
    expect(logSpy.mock.calls[0][0]).toMatch(/\d+\.\d+/);
  });

  test("--help prints help and returns", async () => {
    await main(["--help"]);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    expect(output).toContain("Voice agent development kit");
  });

  test("unknown command calls error and exits", async () => {
    await expect(main(["nonexistent-command"])).rejects.toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("'help' subcommand prints help", async () => {
    await main(["help"]);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    expect(output).toContain("Voice agent development kit");
  });

  test("no args runs init", async () => {
    // With no args, main() dispatches to runInitCommand which tries to render
    // an interactive prompt. In a test environment this throws, confirming
    // that init (not help) was invoked.
    await expect(main([])).rejects.toThrow();
    // Help output should NOT have been printed
    const helpPrinted = logSpy.mock.calls.some(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes("Voice agent development kit"),
    );
    expect(helpPrinted).toBe(false);
  });
});
