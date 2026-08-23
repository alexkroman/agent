// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 22.
 *
 * **This is the BREAKING epoch of its release, and five earlier ones are
 * dropped with 21.** `stubUploads` answers `StubUploads` — `{ restore, writes,
 * read }` — where it answered a bare `() => void`, so every epoch whose example
 * assigned it to a restore function (5, 6, 17, 19) is a compile error, and 21 is
 * dropped rather than retained because its CONTRACT published the old signature
 * even though its own example never called it. `contracts.json` carries the
 * record. Everything else on this epoch is an ADDITION; epochs 2, 3, 4, 7, 8, 9,
 * 12-16, 18 and 20 all still compile beside this file.
 *
 * The change itself is the smaller half of the story. `stubUploads` was the only
 * fake in the family whose shape a spec had to remember was different, and the
 * only way to assert a WRITE happened was to read it back through
 * `uploadInfo`/`readUpload` — through the very seam the step wrote it through, so
 * a spec about writing could not tell a broken write from a broken read.
 *
 * **What epoch 22 adds is three families, each of which every project was
 * re-deriving:**
 *
 * - **The UNWRAPS.** `runTool` answers `unknown`, and it has to: the lookup is by
 *   STRING and discovery is a build step, so there is no tool map at the type
 *   level to recover the author's `R` from. `ok` and `okPosition` are that
 *   recovery, and they THROW on a refusal quoting it — which the cast they
 *   replace cannot do. `(result as { result: Order }).result` reads `undefined`
 *   off a `ToolFailure` and fails several assertions later, with the sentence
 *   the dialog wrote about what has to happen first thrown away.
 * - **The schema pairs.** `~standard` is a wire contract between a schema library
 *   and this SDK, not something a spec should name — and whether a vendor's
 *   `validate` is synchronous or async is the detail a hand-rolled version gets
 *   wrong first: a missing `await` makes `.issues` `undefined` on a promise, and
 *   the negative test then passes for the wrong reason. `parseToolInput` /
 *   `toolInputIssues` name the tool; `parseSchemaInput` / `schemaInputIssues`
 *   take the schema, which is what a WORKFLOW's `input` needs.
 * - **`stubTranscribe`.** The fourth published slot. It refuses by answering an
 *   HTTP STATUS rather than by minting a `TranscribeError`, because the verdict a
 *   spec is testing (`retryable`, `retryAfter`) is what `transcribeFailure`
 *   COMPUTES from that status — a fake that constructed the error would be
 *   asserting the classification instead of exercising it.
 *
 * The five `install*` names are the `/vitest` half of the same fakes: the fake
 * plus `onTestFinished(restore)`, so the runner unwinds it in reverse order
 * instead of a hand-kept `restores` array with an `afterEach` that splices it.
 * They are imported here for their TYPES only — calling one outside a test would
 * throw, and this file is compiled, never run.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { tool } from "../../../index.ts";
import {
  createToolContext,
  ok,
  okPosition,
  parseSchemaInput,
  parseToolInput,
  runTool,
  type StubStepAnswer,
  type StubTranscribe,
  type StubTranscribeCall,
  type StubTranscribeFailure,
  type StubTranscribeLeg,
  type StubTranscribeOptions,
  type StubUploads,
  type StubUploadWrite,
  schemaInputIssues,
  stubTranscribe,
  stubUploads,
  type ToolBearingAgent,
  type ToolContextOverrides,
  toolInputIssues,
  withDiscoveredTools,
} from "../../../sdk/testing.ts";
import {
  installStubReporter,
  installStubSpeech,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
} from "../../../sdk/testing-vitest.ts";

/** What `tools/price_cart.ts` default-exports. A spec imports the module itself. */
export const priceCart = tool({
  description: "Total the cart in the currency the caller asked for.",
  inputSchema: z.object({ currency: z.string() }),
  execute: async ({ currency }) => ({ currency, total: 250 }),
});

/** Unchanged from epoch 21: a harness a spec builds for itself. */
const bench = { label: "cart bench", tools: {} } satisfies ToolBearingAgent & { label: string };

export const wired = withDiscoveredTools(bench, {
  "./tools/price_cart.ts": { default: priceCart },
});

/**
 * New at epoch 22: `createToolContext`'s parameter has a NAME. It is not
 * `Partial<ToolContext>` — an override whose value is `undefined` is dropped
 * rather than spread, so passing one cannot overwrite an inert default with
 * `undefined` and turn a missing collaborator into a `TypeError`.
 */
export const overrides: ToolContextOverrides = { env: { CURRENCY: "usd" } };

/** The unwrap on the registry-lookup path, which is where `unknown` comes from. */
export async function pricedTotal(): Promise<number> {
  const ctx = createToolContext(overrides);
  const priced = ok<{ currency: string; total: number }>(
    await runTool(wired, "price_cart", { currency: "usd" }, ctx),
  );
  return priced.total;
}

/**
 * The dialog half. `okPosition` keeps the envelope, so a spec asserts the state
 * the conversation landed in AND the value in one read; `ok` is this with
 * `.result` taken off the end.
 */
export async function quotedAt(): Promise<string> {
  const ctx = createToolContext();
  const answered = okPosition<{ quoted: number }>(await runTool(wired, "price_cart", {}, ctx));
  return `${answered.state}: ${answered.result.quoted}`;
}

/** Asking a TOOL what it accepts, without reaching through `~standard`. */
export async function parsedArgs(): Promise<string> {
  const parsed = await parseToolInput<{ currency: string }>(wired, "price_cart", {
    currency: "usd",
  });
  return parsed.currency;
}

/** And the negative half: issues, or `undefined` when the input was fine. */
export async function rejectsBadArgs(): Promise<boolean> {
  return (await toolInputIssues(wired, "price_cart", { currency: 7 })) !== undefined;
}

/** The schema-level pair, which is what a WORKFLOW's `input` needs. */
const workflowInput = z.object({ topic: z.string(), limit: z.number().default(5) });

export async function parsedWorkflowInput(): Promise<number> {
  const parsed = await parseSchemaInput<{ topic: string; limit: number }>(workflowInput, {
    topic: "voice",
  });
  return parsed.limit;
}

export async function workflowInputIssues(): Promise<boolean> {
  return (await schemaInputIssues(workflowInput, { topic: 7 })) !== undefined;
}

/**
 * The breaking change, written the new way. `writes` is what makes a step's
 * output assertable WITHOUT reading it back through the seam that wrote it, and
 * `read` is synchronous for the same reason.
 */
export function drivesAStep(): { restore: () => void; wrote: readonly StubUploadWrite[] } {
  const uploads: StubUploads = stubUploads(
    { upl_in: new Uint8Array([1, 2, 3]) },
    { writable: true },
  );
  const seeded: StubUploadWrite | undefined = uploads.read("upl_in");
  return { restore: uploads.restore, wrote: seeded === undefined ? [] : uploads.writes };
}

/** The transcription fake, and the refusal staged as a STATUS rather than an error. */
export function transcription(): StubTranscribe {
  const failure: StubTranscribeFailure = {
    leg: "poll" satisfies StubTranscribeLeg,
    status: 429,
    retryAfterSeconds: 30,
  };
  const options: StubTranscribeOptions = { text: ["one", "two"], failure };
  return stubTranscribe(options);
}

/** Each request the fake answered is tagged with the leg it belonged to. */
export function legs(provider: StubTranscribe): readonly StubTranscribeLeg[] {
  return provider.calls.map((call: StubTranscribeCall) => call.leg);
}

/** A `stepFetch` answer is a `Response` or the record shape, which now has a name. */
export const answer: StubStepAnswer = { status: 200, body: { ok: true } };

/**
 * The `/vitest` half, referenced by TYPE. Each of these is the fake beside it
 * plus `onTestFinished(restore)`, which is a real auto-restore rather than the
 * `vi.stubGlobal` convention `installStubGateway` follows.
 */
export const installers = {
  reporter: installStubReporter,
  speech: installStubSpeech,
  stepFetch: installStubStepFetch,
  transcribe: installStubTranscribe,
  uploads: installStubUploads,
} as const;
