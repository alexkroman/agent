// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate on the eval tier, which needs a real key and spends real tokens.
 *
 * Shaped exactly like `aai-server/_pg-test-utils.ts`, for the same reason: the
 * worst outcome available to a tier nobody runs is a SILENT skip, because a
 * green run of nothing is indistinguishable from a green run of something. So
 * a skip announces itself and prints how to fix it, and `AAI_REQUIRE_EVAL`
 * turns a skip into a hard failure for any pipeline that means to run this.
 *
 * `AAI_REQUIRE_EVAL` is deliberately NOT set by CI. Unlike the Postgres tier
 * there is no argument for gating merges on a live model's behaviour — see
 * `runner.ts`. It exists for the person who ran `pnpm test:eval` and wants to
 * know the tier really ran.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isRecord } from "@alexkroman1/aai/utils";
import { describe } from "vitest";

/**
 * The AssemblyAI key the tier runs on: an exported `ASSEMBLYAI_API_KEY`, else
 * the one `aai login` saved. Same two sources, in the same order, as the repo's
 * other developer tools (`scripts/_api-key.mjs`) — these spend the RUNNER's key.
 */
function resolveKey(): string | undefined {
  const exported = process.env.ASSEMBLYAI_API_KEY;
  if (exported !== undefined && exported.trim() !== "") return exported;
  try {
    const cfg = path.join(homedir(), ".config", "aai", "config.json");
    const parsed: unknown = JSON.parse(readFileSync(cfg, "utf-8"));
    const key = isRecord(parsed) ? parsed.apiKey : undefined;
    return typeof key === "string" && key !== "" ? key : undefined;
  } catch {
    return undefined;
  }
}

const KEY = resolveKey();

const HOW_TO =
  "Export ASSEMBLYAI_API_KEY, or run `aai login` (the tier reads the key it\n" +
  "saves). This tier calls a live model and spends tokens on that key.";

/** What a gated eval file registers its suite with. */
type GatedDescribe = typeof describe | typeof describe.skip;

/**
 * Say something the HARNESS did, on a stream a reporter cannot swallow.
 *
 * Not `console.*`, and the reason is measured. Vitest intercepts `console` and
 * hands the capture to whichever reporter it resolved — and vitest 4 resolves an
 * unset `reporters` to `std-env`'s `isAgent ? "agent" : "default"`, where the
 * agent reporter prints a passing file's captured output NOWHERE. Every line
 * this module and `_register.ts` write is about a file that PASSES: a skip
 * announcing itself, a filter that matched nothing, and the eval REPORT, which
 * is the entire product of the tier. So under an agent all three vanished and
 * the tier's own rule — "the worst outcome available to a tier nobody runs is a
 * SILENT skip" — was being broken by the mechanism meant to enforce it.
 *
 * This repo pins `reporters: ["default"]` in `vitest.shared.ts`, which is why
 * these read correctly here today and why the failure is one nobody would see
 * until the tier ran somewhere else. `announceEvalMode`
 * (`@alexkroman1/aai-runtime/eval/describe.ts`) is the same fix at the SDK layer
 * and carries the full measurement.
 *
 * The stream is the one `console.log`/`console.warn` would have used, so piping
 * behaves as before; only the interception is bypassed.
 */
export function sayFromHarness(text: string, stream: "out" | "err" = "err"): void {
  (stream === "out" ? process.stdout : process.stderr).write(`${text}\n`);
}

/**
 * A precondition the tier needs is missing: say so, or FAIL when a pipeline
 * asked for the tier by name.
 *
 * One function rather than the two copies this had, because the rule is the
 * module's whole subject and the second copy lived in an eval file — the starter
 * eval spelled out its own `AAI_REQUIRE_EVAL` read, its own throw and its own
 * warning for the studio probe, so a change to how a skip announces itself would
 * have reached one gate and not the other.
 */
function announceOrThrow(reason: string, howTo: string): void {
  if ((process.env.AAI_REQUIRE_EVAL ?? "") !== "") {
    // Thrown at import time on purpose: it fails the FILE, which is the one
    // outcome a green-but-skipped suite cannot be confused with.
    throw new Error(`AAI_REQUIRE_EVAL is set but ${reason}.\n${howTo}`);
  }
  sayFromHarness(`\n[skipped: ${reason}] eval tier not run.\n${howTo}\n`);
}

if (KEY === undefined) announceOrThrow("no API key resolved", HOW_TO);

/** `describe` when a key resolved, `describe.skip` otherwise — announced above. */
export const describeEvalTier: GatedDescribe = KEY === undefined ? describe.skip : describe;

/**
 * {@link describeEvalTier}, narrowed by one more precondition of the caller's.
 *
 * The gates COMPOSE: a file needs the key AND its own precondition, so a missing
 * key still skips even when `ok` holds. The starter eval's `/health` probe of the
 * studio origin is the one caller — with a key but no studio every one of its
 * cases would fail as a harness error, which reads like the codegen being broken.
 */
export function describeEvalTierWhen(ok: boolean, reason: string, howTo: string): GatedDescribe {
  if (ok) return describeEvalTier;
  announceOrThrow(reason, howTo);
  return describe.skip;
}

/**
 * The key as a plain `string`, for use inside a `describeEvalTier` body.
 *
 * Read it in a hook or a test, never at the top of the `describe` body: vitest
 * EXECUTES a skipped describe's callback to enumerate what it is skipping, so a
 * throw up there fails the file on a machine with no key instead of skipping it.
 */
export function evalApiKey(): string {
  if (KEY === undefined) {
    throw new Error("evalApiKey() read with no key — call it inside describeEvalTier.");
  }
  return KEY;
}

/** The studio origin the starter eval drives. */
export function evalOrigin(): string {
  return process.env.AAI_EVAL_ORIGIN ?? "http://127.0.0.1:8080";
}

/** Case-name filter, so one case can be iterated on without the rest. */
/**
 * Is the template behaviour contract on?
 *
 * OFF by default, and the default is the point: a contract run is a live model
 * session on top of a codegen turn that already takes minutes, so turning it on
 * for everyone would roughly double the tier's cost and wall clock to answer a
 * question most runs are not asking. `AAI_EVAL_CONTRACTS=1` opts in — see
 * `template-contract.ts` for what it then grades.
 */
export function evalContracts(): boolean {
  const raw = process.env.AAI_EVAL_CONTRACTS;
  return raw !== undefined && raw !== "" && raw !== "0";
}

export function evalOnly(): string | undefined {
  const raw = process.env.AAI_EVAL_ONLY;
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}
