// Copyright 2026 the AAI authors. MIT license.
/**
 * `spawnFfmpeg`'s child handling against a REAL child process.
 *
 * The child is this Node binary running a one-line script rather than ffmpeg,
 * because what is under test here is the spawn policy — bounded output, the
 * deadline, the abort, the stderr tail, the failure kinds — and none of that
 * depends on which binary answers. `ffmpeg.scenario.test.ts` covers the argv
 * against a real ffmpeg.
 */
import { describe, expect, test } from "vitest";
import {
  FFMPEG_STDERR_TAIL_CHARS,
  type FfmpegError,
  type FfmpegRunOptions,
  isFfmpegError,
  spawnFfmpeg,
} from "./_ffmpeg-spawn.ts";

const HINT = { installHint: "ffmpeg", pathEnv: "AAI_FFMPEG_PATH" };

/** Run `script` under Node, through the spawn policy under test. */
function runScript(script: string, options: FfmpegRunOptions = {}) {
  return spawnFfmpeg(process.execPath, ["-e", script], { ...options, ...HINT });
}

/** The {@link FfmpegError} a run failed with, or a thrown error naming what came back. */
async function failureOf(run: Promise<unknown>): Promise<FfmpegError> {
  const outcome: unknown = await run.then(
    (value) => value,
    (err: unknown) => err,
  );
  if (!isFfmpegError(outcome)) throw new Error(`expected an FfmpegError, got ${String(outcome)}`);
  return outcome;
}

describe("spawnFfmpeg", () => {
  test("resolves with stdout and the stderr log on a zero exit", async () => {
    const result = await runScript('process.stdout.write("out"); process.stderr.write("log")');
    expect(Buffer.from(result.stdout).toString()).toBe("out");
    expect(result.stderr).toBe("log");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test("writes `stdin` to the child", async () => {
    const result = await runScript("process.stdin.pipe(process.stdout)", {
      stdin: new TextEncoder().encode("piped"),
    });
    expect(Buffer.from(result.stdout).toString()).toBe("piped");
  });

  test("reports a non-zero exit as `exit`, with the code and the log", async () => {
    const err = await failureOf(runScript('process.stderr.write("bad input"); process.exit(3)'));
    expect(err).toMatchObject({ kind: "exit", exitCode: 3, signal: null, stderr: "bad input" });
    expect(err.message).toContain("with code 3: bad input");
  });

  test("keeps only the TAIL of a long log, marked as cut", async () => {
    const err = await failureOf(
      runScript(
        `process.stderr.write("head" + "x".repeat(${FFMPEG_STDERR_TAIL_CHARS * 2}) + "END"); process.exit(1)`,
      ),
    );
    expect(err.stderr).toHaveLength(FFMPEG_STDERR_TAIL_CHARS + 1);
    expect(err.stderr.startsWith("…")).toBe(true);
    expect(err.stderr.endsWith("END")).toBe(true);
  });

  test("kills a run past its deadline as `timeout`", async () => {
    const err = await failureOf(runScript("setInterval(() => {}, 1000)", { timeoutMs: 200 }));
    expect(err.kind).toBe("timeout");
  });

  test("kills a run the caller aborts as `aborted`, not `timeout`", async () => {
    const controller = new AbortController();
    const run = runScript("setInterval(() => {}, 1000)", { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect((await failureOf(run)).kind).toBe("aborted");
  });

  test("kills a run whose stdout passes the cap", async () => {
    const err = await failureOf(
      runScript('process.stdout.write("x".repeat(4096))', { maxOutputBytes: 1024 }),
    );
    expect(err.kind).toBe("output-too-large");
  });

  test("names the remedy when the binary is not there", async () => {
    const err = await failureOf(spawnFfmpeg("aai-no-such-ffmpeg", ["-version"], HINT));
    expect(err.kind).toBe("missing-binary");
    expect(err.message).toContain("AAI_FFMPEG_PATH");
  });
});
