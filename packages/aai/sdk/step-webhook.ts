// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepWebhookUrl()` — the PUBLIC callback URL for the run this step belongs to,
 * so a third party can wake it instead of the run polling for an answer.
 *
 * A run parks on `ctx.waitFor(token)` and a delivery to this URL is what
 * resolves it. `ctx.workflows.publicWebhookUrl(token)` already mints the same
 * URL — one concept, two surfaces — but only from a `ToolContext`, which a
 * workflow BODY and the steps it calls are handed none of. So a `workflowApp()`
 * with no tools at all (three shipped templates are exactly that) had no way to
 * mint a callback and had to poll a provider until it answered.
 *
 * ## Why a global slot rather than an import, and why the AGENT ENV is not it
 *
 * The publisher and the reader are two module instances in one realm — the agent
 * bundle carries its own copy of this module while the host that publishes
 * imports the SDK from its own graph — which is the whole argument
 * `sdk/step-env.ts` carries; read it there.
 *
 * What is specific to this value is that {@link requireStepEnv} cannot reach it,
 * and that is not obvious: the public base URL is a boot parameter of the
 * DEPLOYMENT, in the guest's EXEC env (`AAI_PUBLIC_BASE_URL`, set by the
 * spawner), while the agent env is the tenant's own `.env` and
 * `aai secret put` keys. `stepEnv` reads `process.env` only when NOTHING has
 * published, and in a guest something always has — so
 * `requireStepEnv("AAI_PUBLIC_BASE_URL")` is `undefined` in production
 * precisely where the URL exists. Publishing it into the agent env instead would
 * break the parity rule that module states: what a step can read is exactly what
 * `.env` and `aai secret put` declare.
 *
 * ## The host publishes a FUNCTION, not a base URL
 *
 * The slot holds a minter that already knows its own route. The alternative —
 * publish the origin and compose here — needs the webhook path in this package,
 * and that path belongs to the server that ANSWERS it: it is
 * `WORKFLOW_WEBHOOK_PREFIX` in `@alexkroman1/aai-runtime`, the same constant
 * `webhookToken` slices a token off and the platform's proxy route derives from.
 * A second spelling of it here would let the URL handed out and the path serving
 * it drift, which is the one failure nothing in the system can see — a run
 * waiting on a hook that never arrives reports as healthily suspended, and the
 * 404 lands weeks later on somebody else's server, on a URL nobody can
 * re-issue. So the composition stays on that side (`workflowWebhookUrl` in
 * `aai-runtime/workflow-serve.ts`) and this module holds the slot and the
 * failure.
 *
 * ## An UNPUBLISHED slot THROWS — it does not answer `undefined`
 *
 * This is the opposite of {@link stepEnv}'s fallback, and deliberately. A
 * missing env key has a legitimate default an author can supply; a callback URL
 * has none — it is either the one a third party can reach or it is a lie
 * (`rejectingWorkflows`' own words about the tool-side accessor, which throws
 * for the same reason). And the silent shape is the expensive one: a step that
 * read `undefined` would submit the job with no callback, park on
 * `ctx.waitFor`, and wait forever with nobody having said so. So the failure is
 * at the mint, with a message naming the configuration.
 */

/**
 * The registry-wide slot. Prefixed with the package name so a second copy of
 * this SDK in the same process (a linked workspace, a mismatched install) shares
 * it rather than shadowing it.
 */
const STEP_WEBHOOK_SLOT = Symbol.for("@alexkroman1/aai.stepWebhookUrl");

/**
 * What a published minter does with one token: answer the absolute URL a third
 * party POSTs to in order to resolve that waitpoint.
 *
 * It receives the token RAW and owns the encoding, because it owns the route —
 * the webhook path is one segment, so the token has to be encoded the same way
 * the parser decodes it, and that is a fact about the router rather than about
 * this call.
 *
 * @internal
 */
export type StepWebhookMinter = (token: string) => string;

/** The shape stored in the slot. `undefined` means nothing has published. */
type StepWebhookSlot = { [STEP_WEBHOOK_SLOT]?: StepWebhookMinter };

/**
 * What {@link stepWebhookUrl} throws when no host published a minter.
 *
 * Exported so the publisher's own specs can assert the message rather than a
 * regex over it, the same reason `SPEECH_UNAVAILABLE_MESSAGE` is. It names all
 * three causes an author can actually be in, because the fix differs: a
 * deployment that was never told its public URL, `aai dev` (where a laptop
 * origin is not reachable from the internet at all — see
 * {@link stepWebhookUrl}), and a spec calling an exported step directly.
 *
 * @internal
 */
export const STEP_WEBHOOK_URL_UNAVAILABLE_MESSAGE =
  "This process cannot mint a public webhook URL, so a step has no callback to hand out. " +
  "On the platform it comes from the deployment (AAI_PUBLIC_BASE_URL in the guest's exec env, " +
  "or AAI_PUBLIC_ORIGIN); on a self-hosted server from `publicUrl` on " +
  "createAgentServer/createRuntime (server.mjs reads PUBLIC_URL). Under `aai dev` there is no " +
  "URL a third party can reach, so exercise a webhook flow against a deployed agent or a " +
  "tunnel. In a test, publish a minter of your own with `publishStepWebhookUrl`.";

/**
 * Publish how this process mints a run's public webhook URL.
 *
 * Called by whatever knows the deployment's public origin — the guest harness at
 * bundle load, from the `AAI_PUBLIC_BASE_URL` the spawner baked into its exec
 * env. Publishing again REPLACES, which is what a redeploy or a repeat load
 * means; passing `undefined` UNPUBLISHES, which is what a host with no public
 * URL and a spec finished with a fake both want, and which is why callers never
 * hand-copy this module's `Symbol.for` key to clear it.
 *
 * @internal — a host concern, exported from `@alexkroman1/aai-runtime`. A step
 * author calls {@link stepWebhookUrl}.
 */
export function publishStepWebhookUrl(mint: StepWebhookMinter | undefined): void {
  if (mint === undefined) delete (globalThis as StepWebhookSlot)[STEP_WEBHOOK_SLOT];
  else (globalThis as StepWebhookSlot)[STEP_WEBHOOK_SLOT] = mint;
}

/**
 * The public URL a third party POSTs to in order to resolve `ctx.waitFor(token)`
 * for the run this step belongs to.
 *
 * The same URL `ctx.workflows.publicWebhookUrl(token)` mints for a tool, reached
 * from a step — which is what lets a `workflowApp()` with no tools hand a
 * provider a callback instead of polling it. Hand it out in the step that
 * submits the work, so the far side is told about the waitpoint before the body
 * parks on it.
 *
 * **One `waitFor` park per token per run, with a poll as the backstop.** A
 * token can be claimed at most ONCE per run — a second claim under a different
 * occurrence key THROWS, and the token is only released when the run goes
 * terminal (`onRunSettled` in `aai-runtime/workflow-journal-memory.ts`, whose
 * comment records a template bitten by exactly this: a derived token served one
 * run, the second claim conflicted, the conflict is not a suspend, and the saga
 * compensated a transcript away). So this belongs in a submit-then-park shape,
 * never a `waitFor` inside a loop — and because a delivery can be lost, missed
 * or never sent, the reconciling backstop is a `waitFor(token, { timeoutMs })`
 * whose `undefined` sends the body to poll the provider once. The callback is
 * what makes the common case fast; the poll is what makes it correct.
 *
 * **Under `aai dev` this throws, and even where a local origin IS configured it
 * is not reachable from the internet.** A public URL is a property of a
 * deployment: the platform bakes it into the guest's exec env, a self-hosted
 * server passes `publicUrl`. A laptop has none, so a real third-party callback
 * cannot be exercised locally — drive that path against a deployed agent, or
 * point a tunnel at the dev server's BACKEND port (the Vite port a developer
 * opens does not proxy `/.well-known/`) and set `PUBLIC_URL` to the tunnel. A
 * spec drives it by publishing a minter of its own.
 *
 * @example
 * Submit the work and hand the callback over in the same step, so the far side
 * is told about the waitpoint before the body parks on it.
 * ```ts
 * import { report, stepFetch, stepWebhookUrl } from "@alexkroman1/aai/step";
 *
 * // The token is DERIVED from the run's own input, so the step handing the URL
 * // out and the body parking on it agree — the rule `ctx.waitFor` states.
 * export const renderToken = (id: string) => `render:${id}`;
 *
 * export async function submitRender(id: string): Promise<void> {
 *   await report(`Submitting render ${id}.`);
 *   await stepFetch("https://renders.example.com/jobs", {
 *     method: "POST",
 *     headers: { "content-type": "application/json" },
 *     body: JSON.stringify({ id, callbackUrl: stepWebhookUrl(renderToken(id)) }),
 *   });
 * }
 * ```
 *
 * @param token - The waitpoint's token, exactly as the body passes it to
 *   `ctx.waitFor`. Derived from the run's input, never random.
 * @returns The absolute URL, encoded for the route's single token segment.
 * @throws {Error} when this process cannot mint one — the message names the
 *   configuration and says what `aai dev` can and cannot do.
 * @throws {Error} when `token` is empty: that composes to the route's own
 *   prefix, which the parser refuses, so the failure would otherwise arrive at
 *   the far end as a 404 on a URL nobody can re-issue.
 * @public
 */
export function stepWebhookUrl(token: string): string {
  const mint = (globalThis as StepWebhookSlot)[STEP_WEBHOOK_SLOT];
  if (!mint) throw new Error(STEP_WEBHOOK_URL_UNAVAILABLE_MESSAGE);
  if (token === "") throw new Error("A webhook token cannot be empty.");
  return mint(token);
}
