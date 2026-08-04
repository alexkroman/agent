// Copyright 2026 the AAI authors. MIT license.
/**
 * The host side of the guest's ONE-SHOT describe mode (see the harness's
 * `mainDescribe`): await the exec'd process and parse its result off stdout.
 * Shared by both backends' describe spawns (`describeModalBundle`,
 * `describeSubprocessBundle`); the backend owns delivering the bundle and
 * starting the process, this module owns the wire format.
 */

import pTimeout from "p-timeout";
import { drainProcStream, type GuestProcLike } from "./warm-harness.ts";

/**
 * Budget for a one-shot describe exec: the bundle's import (top-level code
 * included) plus the JSON print. Generous — a wedged bundle is cut here
 * rather than holding a deploy open.
 */
const DESCRIBE_TIMEOUT_MS = 60_000;

/** Cap on describe stdout retained for parsing (the result is one line). */
const MAX_DESCRIBE_STDOUT_BYTES = 1024 * 1024;

async function collectProcStdout(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      if (out.length >= MAX_DESCRIBE_STDOUT_BYTES) continue; // keep draining
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    return out; // peer died mid-read; the exit path reports the failure
  }
}

/**
 * Await a describe-mode guest and parse its result: the LAST non-empty
 * stdout line is `{ ok, config?, error? }` — last, so a bundle whose top
 * level prints to stdout cannot corrupt it. Stderr drains into host logs.
 * Throws on timeout, unparseable output, or a reported load failure; the
 * caller's cleanup terminates the guest.
 */
export async function readDescribeResult(
  proc: GuestProcLike,
  label: string,
  timeoutMs = DESCRIBE_TIMEOUT_MS,
): Promise<unknown> {
  void drainProcStream(proc.stderr, `[${label}] stderr`);
  const collected = collectProcStdout(proc.stdout);
  const exit = await pTimeout(proc.wait(), {
    milliseconds: timeoutMs,
    message: `bundle describe timed out after ${timeoutMs}ms`,
  });
  const text = await collected;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error(`bundle describe produced no output (exit ${exit})`);
  let parsed: { ok?: unknown; config?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch (err) {
    throw new Error(`bundle describe produced unparseable output (exit ${exit})`, { cause: err });
  }
  if (parsed.ok !== true) {
    const reason = typeof parsed.error === "string" ? parsed.error : `exit ${exit}`;
    throw new Error(`bundle failed to load: ${reason}`);
  }
  return parsed.config;
}
