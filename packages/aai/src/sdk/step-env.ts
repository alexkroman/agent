// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent's env, reachable from inside a step.
 *
 * This is the one thing a durable workflow could not do. A step is handed no
 * `ToolContext` — a body is replayed and may hold nothing live, so there is
 * nothing to hang one on — and so had no way to read the agent's own secrets,
 * which meant no step anywhere
 * could authenticate an outbound call, and every workflow template's I/O was a
 * fixture with a comment explaining why. `AgentDef.requiredEnv`'s own doc said a
 * step "reads keys like any other Node code", which was a claim about
 * `process.env` and false in the two places it mattered: the guest reads the
 * agent env into memory and DELETES the file (`harness-agent-mode.ts`), and
 * `aai dev` resolves `.env` without exporting it.
 *
 * ## Why a global slot rather than a module-level one
 *
 * The PUBLISHER and the READER are two different module instances. The agent
 * bundle is self-contained — `aai build` bundles this module into it along with
 * the `workflows/*.ts` that read it — while the host that publishes (the guest
 * harness, `aai dev`) imports the SDK from its own graph. So a module-level `let`
 * would be published into one instance and read from the other, and the reader
 * would see nothing. `Symbol.for` is registry-wide, so both instances name the
 * same slot; the two run in the same process and the same realm, which is what
 * makes a global work at all here.
 *
 * This used to be argued from the Workflow DevKit's separate step artifact. That
 * artifact is gone — a step is ordinary code in the agent bundle now — and the
 * property it rested on is not: there are still two graphs and still one realm.
 *
 * ## Publishing REPLACES; an unpublished slot falls back to `process.env`
 *
 * Once a host has published an env, that record is the whole answer — there is
 * no per-key fallback, deliberately, because the parity rule `ctx.env` already
 * follows is the one an author has to be able to reason about: what a step can
 * read is exactly what `.env` and `aai secret put` declare, so a key that works
 * under `aai dev` still works after a deploy.
 *
 * An UNPUBLISHED slot is a different situation and not the same tradeoff: it
 * means no agent env exists in this process at all — a spec calling an exported
 * step directly, or a script — and answering `undefined` there would make every
 * step untestable without reaching for the publisher. So that case reads
 * `process.env`, which is what such a caller already controls.
 */

import { missingEnvMessage } from "./_missing-env.ts";

/**
 * The registry-wide slot. Prefixed with the package name so a second copy of
 * this SDK in the same process (a linked workspace, a mismatched install) shares
 * it rather than shadowing it.
 */
const STEP_ENV_SLOT = Symbol.for("@alexkroman1/aai.stepEnv");

/** The shape stored in the slot. `undefined` means nothing has published. */
type StepEnvSlot = { [STEP_ENV_SLOT]?: Readonly<Record<string, string>> };

/**
 * `process.env` where there is a process, an empty record otherwise.
 *
 * Reached off `globalThis` rather than named directly because this module is in
 * `sdk/`, which the browser client's bundle pulls: a bare `process.env` there is
 * a `ReferenceError` at load, not a missing key.
 */
function processEnv(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

/**
 * Publish the agent env for this process's steps.
 *
 * Called by whatever assembled the env and is about to serve workflows — the
 * guest harness at bundle load, `aai dev` on every rebuild. Publishing again
 * REPLACES, which is what a redeploy or a dev-server restart means; a step
 * reads the slot per call, so a step already in flight during a replace sees
 * whichever value it reads and there is nothing to reconcile.
 *
 * Values that are `undefined` are dropped rather than stored, so
 * {@link stepEnv} cannot answer with a key that is present and empty of
 * meaning — the same rule `resolveServerEnv` applies to a declared-but-unset
 * `.env` entry.
 *
 * Passing `undefined` for the whole record UNPUBLISHES — the slot returns to
 * "nothing has published at all", which is a different state from an empty
 * record (that one publishes, and so switches off the `process.env` fallback).
 * It is the same shape as `publishStepFetch(undefined)` /
 * `publishStepReporter(undefined)` / `publishUploadReader(undefined)`, and it
 * exists because without it the only way back was for a caller to hand-copy
 * this module's private `Symbol.for` key and `delete` the global — which two
 * specs did, and which a rename of the constant would have turned into a
 * silent no-op.
 *
 * @internal — a host concern, exported from `@alexkroman1/aai-runtime`. An
 * agent author calls {@link stepEnv}.
 */
export function publishStepEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): void {
  if (env === undefined) {
    delete (globalThis as StepEnvSlot)[STEP_ENV_SLOT];
    return;
  }
  const published: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) published[key] = value;
  }
  (globalThis as StepEnvSlot)[STEP_ENV_SLOT] = Object.freeze(published);
}

/**
 * Read one key of the agent's env from inside a step.
 *
 * @example
 * ```ts
 * import { stepEnv } from "@alexkroman1/aai/step";
 *
 * export async function fetchReport(id: string): Promise<string> {
 *   const base = stepEnv("REPORT_BASE_URL") ?? "https://reports.example.com";
 *   return await (await fetch(`${base}/${id}`)).text();
 * }
 * ```
 *
 * @param name - The env key, as declared in `.env` or set with
 *   `aai secret put`. Listing it in `agent({ requiredEnv })` is what makes a
 *   deploy check it is there.
 * @returns The value, or `undefined` when the agent env does not declare it.
 * @public
 */
export function stepEnv(name: string): string | undefined {
  const published = (globalThis as StepEnvSlot)[STEP_ENV_SLOT];
  // See the module doc: no per-key fallback once an env is published, so a key
  // absent from the agent's env reads the same in dev as it does deployed.
  return published ? published[name] : processEnv()[name];
}

/**
 * {@link stepEnv}, failing by name when the key is not set.
 *
 * The failure a step wants for a credential: an absent key is not transient, so
 * it should say which key and how to set it rather than surface three layers
 * down as an HTTP 401 the engine then retries.
 *
 * It throws a plain `Error` rather than a `FatalError` on purpose — that class
 * is `/step-errors`' and this module must stay importable from a tool body and a
 * spec, neither of which has a workflow around it. A step that wants the retries
 * skipped wraps the call:
 *
 * ```ts no-check
 * try {
 *   key = requireStepEnv("ASSEMBLYAI_API_KEY");
 * } catch (err) {
 *   throw new FatalError(errorMessage(err));
 * }
 * ```
 *
 * @public
 */
export function requireStepEnv(name: string): string {
  const value = stepEnv(name);
  if (!value) {
    throw new Error(missingEnvMessage(name));
  }
  return value;
}
