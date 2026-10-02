// Copyright 2025 the AAI authors. MIT license.

import { beforeEach } from "vitest";
import { type Logger, type RecordedLine, recordingSink, setLogSink } from "./logger.ts";

/**
 * Silence this package's log output for the current file, and record it. Call
 * it at describe scope: it installs the recording sink in a `beforeEach`
 * whose returned restore runs after each test. Prefer asking whether a line was written over
 * pinning its wording — `warns()` returns namespace-prefixed messages.
 */
export function captureLogs(): {
  /** Every line written since the current test began. */
  all(): RecordedLine[];
  /** Messages written at `warn`. */
  warns(): string[];
  /** Messages written at `error`. */
  errors(): string[];
  /** Messages written at `info`. */
  infos(): string[];
} {
  let recorded: { sink: Logger; lines: RecordedLine[] } = recordingSink();
  beforeEach(() => {
    recorded = recordingSink();
    return setLogSink(recorded.sink);
  });
  const at = (level: RecordedLine["level"]) => () =>
    recorded.lines.filter((l) => l.level === level).map((l) => l.msg);
  return {
    all: () => recorded.lines,
    warns: at("warn"),
    errors: at("error"),
    infos: at("info"),
  };
}
