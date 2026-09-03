// Copyright 2026 the AAI authors. MIT license.
/**
 * The WORKFLOW-APP arm of `AgentParams` — `page: "static"` and the twenty
 * fields it has no use for.
 *
 * Split out of `agent-params.ts` when that file crossed the 500-line cap. The
 * seam is the natural one: everything here is about the arm that has no
 * session, and nothing in the three VOICE arms names it. `agent-params.ts`
 * re-exports the four public names so an author's import is unchanged.
 */

import type {
  FrontDoorField,
  PipelineOnlyField,
  ProviderField,
  SharedAgentParams,
} from "./agent-params.ts";
import type { AgentDef } from "./types.ts";

/**
 * The {@link AgentDef} fields a WORKFLOW APP cannot use, typed as messages on
 * {@link StaticAgentParams}.
 *
 * A `page: "static"` agent has no session and no LLM loop: nothing reads a
 * system prompt, nothing executes a tool, nothing opens the socket `syncState`
 * pushes over. Every one of these was silently ACCEPTED and inert before this
 * arm existed, and the `link-digest` template shipped a `systemPrompt`
 * addressed to a model that never runs — with a comment claiming
 * `GET /client-config` served it, which serves `name`/`greeting`/`page` and
 * has never carried a system prompt.
 *
 * Derived from the two existing lists where they already say this, so a new
 * pipeline knob or provider stage is rejected here for free.
 */
export type WorkflowAppOnlyField =
  | ProviderField
  | PipelineOnlyField
  | "system"
  | "systemPrompt"
  | "sttPrompt"
  | "maxSteps"
  | "toolChoice"
  // `tools` is deliberately NOT here, though a workflow app has no model to
  // call one: it would give the field two messages across the union, and tsc
  // prints the whole union at every call site. It printed the workflow-app
  // sentence FIRST, so an author who wrote a plain voice agent — the
  // overwhelmingly common case for this mistake — was told about
  // `page: "static"`, a thing they had never heard of, before the sentence that
  // names the file to create. One message for one field: the arm inherits
  // `tools?: InlineToolsMisuse` from `SharedAgentParams`, which is true of
  // every arm (a tool is a FILE) and leads with the remedy.
  | "builtinTools"
  | "minTurnSilenceMs"
  | "maxTurnSilenceMs"
  | "syncState"
  // Session events, for the same reason `syncState` is here: there is no session
  // to observe. A workflow app's own narration is `report()` from a step.
  | "events"
  | "idleTimeoutMs"
  | "voice";

/** The message a {@link WorkflowAppOnlyField} carries. */
export type WorkflowAppMisuse<K extends string> =
  `\`${K}\` has no effect on a workflow app — \`page: "static"\` runs no model and opens no session; remove it, or remove \`page: "static"\` to make this a voice agent`;

/**
 * Workflow-app params: `page: "static"`, the workflows that ARE the product,
 * and nothing from the session half of the agent shape.
 *
 * Not a session mode like the other three arms — a front door. What it drops is
 * everything downstream of having a session at all.
 *
 * What it keeps is the surface a page and a deploy actually read: `name` and
 * `greeting` (both served by `GET /client-config`, so a page can render its
 * shell from the agent — `page()` does not fetch it the way `client()` does, so
 * a page that wants them calls `fetchClientConfig()` itself), `workflows`, and
 * `requiredEnv` (a step reads keys with `stepEnv` from
 * `@alexkroman1/aai/step`, and a deploy still checks they are present).
 *
 * `workflows` is REQUIRED here, unlike on {@link AgentDef}: a workflow app whose
 * whole API is `/workflows/*` and which declares none serves a form with nothing
 * behind it, and the page's `api.start(name, …)` would 400 on every submit.
 *
 * @remarks
 * The long string-literal types on the fields below are COMPILE-ERROR MESSAGES,
 * not values this arm accepts. Setting one of those fields makes `tsc` print the
 * sentence in place of a bare excess-property error, so the diagnostic names the
 * rule and what to do about it. Never pass one as a string.
 */
export type StaticAgentParams = Omit<StaticAgentParamsCore, WorkflowAppOnlyField> & {
  [K in WorkflowAppOnlyField]?: WorkflowAppMisuse<K>;
};

/**
 * The static arm as it appears in the {@link AgentParams} union that `agent()`
 * takes — {@link StaticAgentParams} WITHOUT the compile-error messages.
 *
 * The split exists because **tsc prints the whole union at every call site**,
 * so a message on one arm is a message on every diagnostic. Measured, before
 * the split: `agent({ name: "Broken", maxSteps: "12" })` — a plain voice agent,
 * an ordinary one-character mistake — reported
 *
 *     Type 'string' is not assignable to type 'number | "`maxSteps` has no
 *     effect on a workflow app — `page: "static"` runs no model and opens no
 *     session; …"'
 *
 * telling an author about a front door they had never heard of, and burying
 * `number`. Every one of the twenty `WorkflowAppOnlyField` names did this.
 *
 * This is exactly the hazard the `tools` comment in `WorkflowAppOnlyField`
 * diagnosed — "it would give the field two messages across the union, and tsc
 * prints the whole union at every call site" — generalized from the one field
 * that got the remedy to all of them. The messages are not lost: they live on
 * the arm {@link workflowApp} takes, which is where an author who really is
 * writing a workflow app arrives, and where `page: "static"` is not a surprise.
 * Reaching the static arm through `agent({ page: "static" })` still works and
 * now reports a plain excess-property error naming the field.
 *
 * This is the arm both public names are built from, and it is deliberately the
 * one on the barrel: `AgentParams` names it, so a reader following that union
 * has somewhere to land. {@link StaticAgentParams} `Omit`s these keys before
 * re-adding them as messages rather than intersecting the two maps — an
 * intersection of `never` with a message type is `never`, which would silently
 * take the sentence away from `workflowApp()`, the one place it belongs.
 *
 * @public
 */
export type StaticAgentParamsCore = Omit<
  SharedAgentParams,
  WorkflowAppOnlyField | FrontDoorField | "workflows"
> & {
  /** See {@link AgentDef.page} — the explicit opt-in to a workflow app. */
  page: "static";
  /**
   * See {@link AgentDef.workflows}. The whole product: a workflow app is an
   * agent whose work happens here.
   */
  workflows: NonNullable<AgentDef["workflows"]>;
} & {
  // `never`, not the message — and the difference is the whole point of the
  // split. The KEY has to be present and un-satisfiable or the field is merely
  // absent, and an absent field is structurally fine: `{ page: "static",
  // workflows, systemPrompt: string }` would extend this arm, which
  // `define.test-d.ts` exists to forbid. `never` rejects it exactly as the
  // message did, and is ABSORBED in the union tsc prints — so a voice agent's
  // `maxSteps: "12"` reads `number`, where the message made it read
  // `number | "\`maxSteps\` has no effect on a workflow app — …"`.
  [K in WorkflowAppOnlyField]?: never;
};
