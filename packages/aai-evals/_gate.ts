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
  console.warn(`\n[skipped: ${reason}] eval tier not run.\n${howTo}\n`);
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
export function evalOnly(): string | undefined {
  const raw = process.env.AAI_EVAL_ONLY;
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}
