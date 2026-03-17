// Copyright 2025 the AAI authors. MIT license.
import { expect, test, vi } from "vitest";
import { error, info, step, stepInfo, warn } from "./_output.ts";

test("step writes action prefix to stdout", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  step("Bundle", "my-agent");
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy.mock.calls[0]![0]).toContain("Bundle");
  expect(logSpy.mock.calls[0]![0]).toContain("my-agent");
  logSpy.mockRestore();
});

test("stepInfo writes action prefix to stdout", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  stepInfo("Watch", "for changes...");
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy.mock.calls[0]![0]).toContain("Watch");
  logSpy.mockRestore();
});

test("info writes to stdout", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  info("secondary note");
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy.mock.calls[0]![0]).toContain("secondary note");
  logSpy.mockRestore();
});

test("warn writes to stderr", () => {
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warn("careful");
  expect(errSpy).toHaveBeenCalledTimes(1);
  expect(errSpy.mock.calls[0]![0]).toContain("careful");
  errSpy.mockRestore();
});

test("error writes to stderr", () => {
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  error("oops");
  expect(errSpy).toHaveBeenCalledTimes(1);
  expect(errSpy.mock.calls[0]![0]).toContain("oops");
  errSpy.mockRestore();
});
