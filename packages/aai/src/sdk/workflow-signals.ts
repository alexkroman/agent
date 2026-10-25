// Copyright 2026 the AAI authors. MIT license.
/**
 * Signals derived from the run's KEY: the one token grammar a body, the tool
 * that signals it and a third party's webhook all compute.
 *
 * A hook token must be derivable on both sides — `WorkflowContext.waitFor`
 * says so, and left each app to export a helper that composed one from the
 * run's input. Every such helper was the same template literal, and the two
 * sides disagreed by a prefix often enough to park a run on a token nobody
 * signalled. The token is minted HERE instead, from three things both sides
 * already hold: the workflow's declared name, the run's `StartOptions.key`, and
 * a label the body chooses:
 *
 * ```text
 * <workflow>:<key>:<label>
 * ```
 *
 * `ctx.waitForSignal(label)` waits on it, `ctx.signalToken(label)` hands it to
 * a step (`stepWebhookUrl(ctx.signalToken("transcript"))`), and
 * `ctx.workflows.signalRun(def, key, label, payload)` answers it from a tool —
 * none of them spelling the grammar. A run started with NO key has no token to
 * derive, and both body methods THROW rather than mint one from `undefined`:
 * a run parked on `digest:undefined:approval` is a run nobody can answer.
 *
 * Every `WorkflowContext` delegates to the two helpers here, as it does to
 * `pollWorkflow`, so the engine, the `/testing` recorder and an eval agree on
 * the token for one label.
 *
 * @internal — reached by a host through `@alexkroman1/aai/host-internal`; an
 * author calls `ctx.waitForSignal`, `ctx.signalToken` and
 * `ctx.workflows.signalRun`.
 */

import type { WaitForOptions, WaitForSchemaOptions } from "./workflow-ctx-options.ts";

/**
 * The token a signal for `label` on the run of `workflow` keyed `key` travels
 * under.
 *
 * `:`-joined and unescaped on purpose: a token is a capability (it addresses a
 * run), and the key is session-scoped, so the join's ambiguity for a key that
 * itself carries a `:` costs nothing a signaller could exploit — it would have
 * to know the key either way. What it buys is a token a person can read in a
 * journal and a webhook log.
 *
 * @internal
 */
export function workflowSignalToken(workflow: string, key: string, label: string): string {
  return `${workflow}:${key}:${label}`;
}

/**
 * What a signal-token method reads off its context: the declared name and the
 * run's key.
 *
 * @internal
 */
export type SignalHost = {
  readonly workflow: string;
  readonly key: string | undefined;
};

/**
 * `ctx.signalToken(label)` over `host`, or a throw naming the fix when the run
 * has no key.
 *
 * @internal
 */
export function signalTokenFor(host: SignalHost, label: string): string {
  if (host.key === undefined) {
    throw new Error(
      `ctx.signalToken(${JSON.stringify(label)}): this run of ${JSON.stringify(host.workflow)} ` +
        "has no key, so no signal token can be derived for it. Start it with a key — " +
        "ctx.workflows.start(def, input, { key }) — which a tool gets by default (the " +
        "session id); a body or a route must pass one explicitly.",
    );
  }
  return workflowSignalToken(host.workflow, host.key, label);
}

/**
 * The one wait method a signal wait is made of — `ctx.waitFor` with the TOKEN
 * unconstrained.
 *
 * @internal
 */
export type SignalWaitHost = SignalHost & {
  waitFor(token: string, options?: WaitForOptions | WaitForSchemaOptions): Promise<unknown>;
};

/**
 * `ctx.waitForSignal(label, options)` over `host`: the derived token handed to
 * `ctx.waitFor`, so it journals as `hook!<workflow>:<key>:<label>#<occurrence>`.
 *
 * @internal
 */
export async function waitForSignalWorkflow(
  host: SignalWaitHost,
  label: string,
  options?: WaitForOptions | WaitForSchemaOptions,
): Promise<unknown> {
  // `async`, so a keyless run's refusal is a REJECTION like every other wait
  // failure, never a synchronous throw out of an `await`-less call.
  const token = signalTokenFor(host, label);
  return await host.waitFor(token, options);
}
