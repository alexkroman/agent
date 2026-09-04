// Copyright 2025 the AAI authors. MIT license.

import type { Readable } from "node:stream";
import { isRecord } from "@alexkroman1/aai/utils";
import * as p from "@clack/prompts";
import pTimeout from "p-timeout";
import { checkedResponse, isStringArray } from "./_api-client.ts";
import { CliError, type CommandResult, fail, type OutputMode, ok } from "./_output.ts";
import { secretRequest } from "./_slug-api.ts";
import { log, unwrapCancel } from "./_ui.ts";

/**
 * The one `no_input` failure for `secret put`, shared by every path that can
 * reach it — the stdin read that came back empty, the refusal when stdin is a
 * terminal and JSON mode cannot prompt, and the prompt the user dismissed —
 * so the three cannot drift.
 *
 * It is built here rather than kept as a fixed tuple so the hint can name the
 * secret AND both ways of supplying a value: that sentence is the contract,
 * and until this commit it appeared nowhere — not in `--help`, not in the
 * scaffolded README (which said it prompts), and not in the failure itself,
 * which said only "Pipe secret value to stdin".
 */
function noInput(name: string, detail: string): { code: string; message: string; hint: string } {
  return {
    code: "no_input",
    message: `No value provided for ${name} (${detail})`,
    hint:
      `Pipe the value in — \`printf %s "$VALUE" | aai secret put ${name}\` — ` +
      "or run the command on a terminal to be prompted for it.",
  };
}

/**
 * How long stdin may stay SILENT before `secret put` gives up on it.
 *
 * It bounds only the FIRST byte — a producer that has started is then given
 * as long as it likes, because a secret usually comes out of something slow
 * (`pass show`, `op read`, a KMS call) and cutting it off mid-value would be
 * worse than waiting.
 *
 * What the bound is for is stdin with no producer behind it at all: an
 * inherited-but-idle pipe, which is what an agent harness, a CI step, a
 * supervisor and an editor task all hand a child. Reading to EOF is correct
 * and the EOF was never coming, so the command printed NOTHING and blocked
 * forever — on the only documented way to get a credential into production.
 * A bounded wait that ends in a sentence naming both working forms is the
 * whole difference between "unusable" and "I typed it wrong".
 */
const STDIN_FIRST_BYTE_MS = 10_000;

/**
 * Read stdin to EOF, giving up if nothing arrives at all — `undefined` for
 * that case, distinct from `""` for a producer that sent nothing and closed.
 *
 * Hand-rolled rather than `text(process.stdin)` because the deadline has to
 * apply to the first chunk and NOT to the whole read; `p-timeout`'s
 * `message: false` resolves `undefined` instead of rejecting, so there is no
 * timer to clear and no losing branch to reject late.
 */
async function readStdinToEnd(stdin: Readable, firstByteMs: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  const firstByte = Promise.withResolvers<true>();
  const ended = Promise.withResolvers<void>();
  const onData = (chunk: Buffer): void => {
    chunks.push(chunk);
    firstByte.resolve(true);
  };
  const onEnd = (): void => {
    firstByte.resolve(true);
    ended.resolve();
  };
  const onError = (err: Error): void => {
    firstByte.reject(err);
    ended.reject(err);
  };
  stdin.on("data", onData).once("end", onEnd).once("error", onError);
  try {
    const arrived = await pTimeout(firstByte.promise, {
      milliseconds: firstByteMs,
      message: false,
    });
    if (!arrived) return undefined;
    await ended.promise;
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally {
    // Both halves matter on the give-up path: the listeners are what would
    // keep this process alive waiting for an EOF nobody is going to send,
    // and an `error` arriving after we stopped caring would be unhandled.
    stdin.off("data", onData).off("end", onEnd).off("error", onError);
    stdin.pause();
  }
}

/**
 * The environment {@link resolveSecretValue} branches on, as a seam a spec can
 * supply — a `Readable` rather than a fake reader function, so a test drives
 * the real wait (the part that blocked) and needs no cast to stand in for
 * `process.stdin`.
 */
export type SecretValueIo = {
  /** Defaults to `process.stdin`. */
  stdin?: Readable | undefined;
  /** Defaults to whether the real stdin is a terminal. */
  stdinIsTTY?: boolean | undefined;
  /** Defaults to {@link STDIN_FIRST_BYTE_MS}. */
  firstByteMs?: number | undefined;
};

/**
 * The value for `secret put`, from whichever source is actually available —
 * or `undefined` to mean "prompt", which {@link executeSecretPut} does.
 *
 * Keyed off STDIN, deliberately, and never off the output mode. A stdin read
 * resolves at EOF and a terminal never sends one, so keying the read off
 * `mode === "json"` — which is decided by STDOUT — made `aai secret put NAME`
 * print NOTHING and block forever in every context where stdout is not a
 * terminal but stdin still is: a CI step, `| tee`, an agent harness, an
 * editor task. That is the worst failure a CLI can have on the only
 * documented way to get a credential into production, and it is why each of
 * the three cases below is answered at once:
 *
 * - stdin is a pipe or a file: read it to EOF — the documented contract —
 *   bounded on the FIRST byte so an idle inherited pipe cannot block the
 *   command forever (see {@link STDIN_FIRST_BYTE_MS}). An empty read is
 *   refused rather than sent to the server.
 * - stdin is a terminal, human output: `undefined`, so the executor prompts.
 * - stdin is a terminal, JSON output: refused immediately. JSON mode promises
 *   exactly one result line on stdout and cannot spend it on a prompt — so it
 *   says which two forms do work instead of waiting for an EOF that a person
 *   sitting at a terminal has no reason to send.
 */
export async function resolveSecretValue(
  name: string,
  mode: OutputMode,
  io: SecretValueIo = {},
): Promise<string | undefined> {
  const stdinIsTTY = io.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  if (!stdinIsTTY) {
    const firstByteMs = io.firstByteMs ?? STDIN_FIRST_BYTE_MS;
    const piped = await readStdinToEnd(io.stdin ?? process.stdin, firstByteMs);
    if (piped) return piped;
    const { code, message, hint } = noInput(
      name,
      piped === undefined
        ? `nothing arrived on stdin within ${Math.round(firstByteMs / 1000)}s`
        : "stdin was empty",
    );
    throw new CliError(code, message, hint);
  }
  if (mode === "json") {
    const { code, message, hint } = noInput(name, "stdin is a terminal and --json cannot prompt");
    throw new CliError(code, message, hint);
  }
  return undefined;
}

type SecretPutData = { name: string };
type SecretDeleteData = { name: string };
type SecretListData = { secrets: string[] };

/**
 * Execute secret put. If `value` is provided, use it directly (the stdin
 * path). If not, prompt for it — masked — which is what
 * {@link resolveSecretValue} returning `undefined` asks for.
 */
export async function executeSecretPut(
  cwd: string,
  name: string,
  value: string | undefined,
  server: string | undefined,
): Promise<CommandResult<SecretPutData>> {
  let secretValue = value;

  if (!secretValue) {
    // TTY path — interactive prompt
    const result = unwrapCancel(await p.password({ message: `Enter value for ${name}` }));
    if (!result) {
      const { code, message, hint } = noInput(name, "the prompt came back empty");
      return fail(code, message, hint);
    }
    secretValue = result;
  }

  const { target } = await secretRequest(
    cwd,
    "",
    { method: "PUT", body: { [name]: secretValue }, action: "secret" },
    server,
  );
  log.success(`Set ${name} for ${target}`);
  return ok({ name });
}

export async function executeSecretDelete(
  cwd: string,
  name: string,
  server: string | undefined,
): Promise<CommandResult<SecretDeleteData>> {
  // Encoded so a name containing `/`, `?`, `#`, or `%` can't target a
  // different path (or truncate the request) on the server.
  const { target } = await secretRequest(
    cwd,
    `/${encodeURIComponent(name)}`,
    { method: "DELETE", action: "secret" },
    server,
  );
  log.success(`Deleted ${name} from ${target}`);
  return ok({ name });
}

export async function executeSecretList(
  cwd: string,
  server: string | undefined,
): Promise<CommandResult<SecretListData>> {
  const { data, target } = await secretRequest(cwd, "", { action: "secret" }, server);
  // Checked, not cast: a 200 without `vars` died on `Cannot read properties of
  // undefined (reading 'length')` — a stack trace where the CLI's own error
  // sentence belongs. See `checkedResponse`.
  const { vars } = checkedResponse(
    data,
    (value): value is { vars: string[] } => isRecord(value) && isStringArray(value.vars),
    `the secret list for ${target}`,
  );
  if (vars.length === 0) {
    log.info("No secrets set. Use `aai secret put <name>` to add one.");
  } else {
    log.message(`${vars.length} secret${vars.length === 1 ? "" : "s"}:`);
    for (const v of vars) {
      log.message(`  ${v}`);
    }
  }
  return ok({ secrets: vars });
}
