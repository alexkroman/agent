// Copyright 2026 the AAI authors. MIT license.
// The `AAI_CHANNEL_OUTBOX` sink: one JSON line per send, logs that never name
// the recipient or the text. The file write is injected — the unit tier touches
// no disk.

import path from "node:path";
import { publishChannelOutbox } from "@alexkroman1/aai/host-internal";
import { afterEach, describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { CHANNEL_OUTBOX_ENV, createChannelOutbox, installChannelOutbox } from "./channel-outbox.ts";
import type { LogFn, Logger } from "./runtime-config.ts";

afterEach(() => publishChannelOutbox(undefined));

/** A writer that keeps nothing: these tests read what was LOGGED. */
const discard = async (): Promise<void> => undefined;

function recordingLogger() {
  const info = vi.fn<LogFn>();
  const logger: Logger = { ...silentLogger, info };
  return Object.assign(logger, { info });
}

describe("createChannelOutbox", () => {
  test("appends one timestamped JSON line per send", async () => {
    const write = vi.fn(async (_file: string, _line: string): Promise<void> => undefined);
    const sink = createChannelOutbox({
      file: "/project/.aai/outbox.jsonl",
      logger: silentLogger,
      write,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    await sink({ kind: "textbelt", to: "+15555550123", body: { message: "hi" } });
    await sink({ kind: "slack", body: { text: "done" } });
    expect(write.mock.calls.map(([file]) => file)).toEqual([
      "/project/.aai/outbox.jsonl",
      "/project/.aai/outbox.jsonl",
    ]);
    const lines = write.mock.calls.map(([, line]) => line);
    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        at: "2026-01-02T03:04:05.000Z",
        kind: "textbelt",
        to: "+15555550123",
        body: { message: "hi" },
      },
      { at: "2026-01-02T03:04:05.000Z", kind: "slack", body: { text: "done" } },
    ]);
  });

  test("logs the kind and the size, never the number or the text", async () => {
    const logger = recordingLogger();
    const sink = createChannelOutbox({ file: "/x.jsonl", logger, write: discard });
    await sink({ kind: "textbelt", to: "+15555550123", body: { message: "secret plans" } });
    expect(logger.info).toHaveBeenCalledOnce();
    const logged = JSON.stringify(logger.info.mock.calls[0]);
    expect(logged).toContain("textbelt");
    expect(logged).not.toContain("+15555550123");
    expect(logged).not.toContain("secret plans");
  });

  test("a failed write fails the send rather than claiming it was captured", async () => {
    const sink = createChannelOutbox({
      file: "/x.jsonl",
      logger: silentLogger,
      write: async () => {
        throw new Error("EACCES");
      },
    });
    await expect(sink({ kind: "slack", body: {} })).rejects.toThrow("EACCES");
  });
});

describe("installChannelOutbox", () => {
  test("unset or blank publishes nothing and says nothing", () => {
    const logger = recordingLogger();
    expect(installChannelOutbox(logger, {})).toBeUndefined();
    expect(installChannelOutbox(logger, { [CHANNEL_OUTBOX_ENV]: "  " })).toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
  });

  test("a path resolves against the cwd and is announced once at boot", () => {
    const logger = recordingLogger();
    const file = installChannelOutbox(logger, { [CHANNEL_OUTBOX_ENV]: "out/texts.jsonl" });
    expect(file).toBe(path.resolve("out/texts.jsonl"));
    expect(logger.info).toHaveBeenCalledWith("Channels go to an outbox", {
      path: file,
      detail: "nothing is sent: texts and posts are appended to this file",
    });
  });
});
