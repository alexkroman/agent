// Copyright 2026 the AAI authors. MIT license.
/**
 * The host side of the guest's ONE-SHOT describe mode (see the harness's
 * `mainDescribe`): await the exec'd process and parse its result off stdout.
 * Shared by both backends' describe spawns (`describeModalBundle`,
 * `describeSubprocessBundle`); the backend owns delivering the bundle and
 * starting the process, this module owns the wire format.
 */

import { randomBytes } from "node:crypto";
import pTimeout from "p-timeout";
import { consumeProcStream, drainProcStream, type GuestProcLike } from "./warm-harness.ts";

/**
 * Mint the per-exec marker that identifies the HARNESS's answer.
 *
 * The bundle is imported into the describe process, so "the last stdout
 * line wins" is not by itself a defense: a `process.on("exit")` handler in
 * the bundle prints after the harness and its line is last. Measured — a
 * bundle doing exactly that had its own `{ok:true,config}` accepted as the
 * extracted config, letting a deploy declare a config the SDK never
 * produced (an empty `requiredEnv` skips the credential preflight).
 *
 * The harness deletes this from `process.env` before importing the bundle,
 * so bundle code cannot read the value it would have to forge.
 */
export function mintDescribeNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Budget for a one-shot describe exec: the bundle's import (top-level code
 * included) plus the JSON print. Generous — a wedged bundle is cut here
 * rather than holding a deploy open.
 */
const DESCRIBE_TIMEOUT_MS = 60_000;

/** Cap on describe stdout retained for parsing (the result is one line). */
const MAX_DESCRIBE_STDOUT_BYTES = 1024 * 1024;

async function collectProcStdout(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  await consumeProcStream(stream, (value) => {
    if (out.length >= MAX_DESCRIBE_STDOUT_BYTES) return; // keep draining
    out += decoder.decode(value, { stream: true });
  });
  return out;
}

/**
 * Await a describe-mode guest and parse its result: the last stdout line
 * carrying `nonce` is `{ ok, config?, error? }`. Matching on the nonce, not
 * merely on being last, is what makes the answer the harness's rather than
 * the bundle's — see {@link mintDescribeNonce}. Stderr drains into host
 * logs. Throws on timeout, unparseable output, or a reported load failure;
 * the caller's cleanup terminates the guest.
 */
export async function readDescribeResult(
  proc: GuestProcLike,
  label: string,
  /** The marker handed to this exec via `AAI_DESCRIBE_NONCE`. */
  nonce: string,
  timeoutMs = DESCRIBE_TIMEOUT_MS,
): Promise<unknown> {
  void drainProcStream(proc.stderr, `[${label}] stderr`);
  const collected = collectProcStdout(proc.stdout);
  const exit = await pTimeout(proc.wait(), {
    milliseconds: timeoutMs,
    message: `bundle describe timed out after ${timeoutMs}ms`,
  });
  const text = await collected;
  // Scan from the end for the harness's own line. Bundle output — including
  // anything printed from an exit handler, i.e. AFTER us — simply isn't it.
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error(`bundle describe produced no output (exit ${exit})`);
  let parsed: { ok?: unknown; config?: unknown; error?: unknown } | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    let candidate: { nonce?: unknown };
    try {
      candidate = JSON.parse(lines[i] as string) as typeof candidate;
    } catch {
      continue;
    }
    if (candidate.nonce === nonce) {
      parsed = candidate as typeof parsed;
      break;
    }
  }
  if (!parsed) {
    throw new Error(
      `bundle describe produced no harness result (exit ${exit}) — the guest printed no line ` +
        `carrying this exec's marker`,
    );
  }
  if (parsed.ok !== true) {
    const reason = typeof parsed.error === "string" ? parsed.error : `exit ${exit}`;
    throw new Error(`bundle failed to load: ${reason}`);
  }
  return parsed.config;
}
