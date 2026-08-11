// Copyright 2026 the AAI authors. MIT license.
/**
 * Provider warnings must reach the server log.
 *
 * A warning means the provider IGNORED something we asked for, which is the
 * failure mode this repo keeps re-discovering the hard way (`sttPrompt`
 * silently dropped for S2S agents; `reasoning_effort` on a model family that
 * refuses tools beside it). Before this they went to the SDK's own one-shot
 * console print and nowhere a server log aggregates.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { installProviderWarningLogger } from "./llm-warnings.ts";
import type { Logger } from "./runtime-config.ts";

/**
 * The installed hook. Typed `LogWarningsFunction | undefined | false` by the
 * SDK (`false` is its "print nothing" setting), so the tests narrow once here
 * rather than at every call — and a `false` left behind would fail loudly.
 */
function hook(): NonNullable<Exclude<typeof globalThis.AI_SDK_LOG_WARNINGS, false>> {
  const installed = globalThis.AI_SDK_LOG_WARNINGS;
  if (typeof installed !== "function") throw new Error("no warning logger installed");
  return installed;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } satisfies Logger;
}

afterEach(() => {
  globalThis.AI_SDK_LOG_WARNINGS = undefined;
});

describe("installProviderWarningLogger", () => {
  test("routes each warning to the logger with the provider and model", () => {
    const log = makeLogger();
    installProviderWarningLogger(log, true);

    hook()({
      provider: "assemblyai",
      model: "gpt-5.6-terra",
      warnings: [{ type: "unsupported", feature: "temperature", details: "ignored" }],
    });

    expect(log.warn).toHaveBeenCalledWith("Provider warning", {
      provider: "assemblyai",
      model: "gpt-5.6-terra",
      type: "unsupported",
      feature: "temperature",
      details: "ignored",
    });
  });

  // The union names the dropped thing differently per arm, and that name is
  // the whole content of the warning — narrowing to one arm would log a type
  // and no subject.
  test("forwards whichever field names the dropped thing", () => {
    const log = makeLogger();
    installProviderWarningLogger(log, true);

    hook()({
      warnings: [
        { type: "deprecated", setting: "maxTokens", message: "use maxOutputTokens" },
        { type: "other", message: "something else" },
      ],
    });

    expect(log.warn).toHaveBeenNthCalledWith(1, "Provider warning", {
      type: "deprecated",
      setting: "maxTokens",
      message: "use maxOutputTokens",
    });
    expect(log.warn).toHaveBeenNthCalledWith(2, "Provider warning", {
      type: "other",
      message: "something else",
    });
  });

  test("installs ONCE per process, because the hook is process-global", () => {
    // `aai dev` rebuilds its runtime on every file save; a per-runtime install
    // would be a second line per warning per reload.
    const first = makeLogger();
    const second = makeLogger();
    installProviderWarningLogger(first, true);
    installProviderWarningLogger(second);

    hook()({ warnings: [{ type: "other", message: "x" }] });

    expect(first.warn).toHaveBeenCalledTimes(1);
    expect(second.warn).not.toHaveBeenCalled();
  });

  test("does not disable the SDK's warnings, it redirects them", () => {
    // `AI_SDK_LOG_WARNINGS = false` is the SDK's "say nothing" setting. The
    // point here is the opposite: the same information, somewhere collected.
    installProviderWarningLogger(makeLogger(), true);
    expect(typeof globalThis.AI_SDK_LOG_WARNINGS).toBe("function");
  });
});
