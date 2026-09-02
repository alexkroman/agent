// Copyright 2026 the AAI authors. MIT license.
/**
 * A `RuntimeOptions` member `createAgentServer` does not forward is a COMPILE
 * ERROR unless somebody wrote down why.
 *
 * `AgentServerOptions` is a hand-written subset of `RuntimeOptions`, and every
 * field on it is optional, so an option added to the runtime is silently
 * unreachable through the door most deployments use. That is not a hazard to
 * remember — it has happened FOUR times, and each was found by somebody needing
 * the option rather than by anything checking:
 *
 * - **`telephony`** defaulted to `!isStatic` in `createServer` and was not
 *   forwarded, so every server built through the documented door — the
 *   scaffold's `server.mjs` included — mounted an unauthenticated `WS /phone`
 *   with no way to switch it off.
 * - **`page`** is declared by the AGENT, and nothing carried the declaration
 *   through, so a `page: "static"` agent still got the voice surfaces and a
 *   voice `GET /client-config`.
 * - **`env`** was forwarded to the runtime alone, so three of the four things
 *   `createServer` reads out of an env were dropped: `AAI_WORKFLOW_API_TOKEN`
 *   did nothing (the workflow API and its upload write routes stayed open),
 *   `AAI_SESSION_EVENTS_TOKEN` did nothing, and `DATABASE_URL` did nothing —
 *   so an upload's record went to a temp directory and was gone before a
 *   resumed run read it.
 * - **`journal`** left a deployment that owns a database unable to say so: its
 *   durable runs went wherever the runtime guessed.
 *
 * ## Why a TYPE and not a rule in the guide
 *
 * The guide has carried this rule for three of the four ("Forward one of those
 * when somebody needs it, not before") and the fourth still happened. A subset
 * that must be justified member by member is exactly the shape
 * `packages/aai/CLAUDE.md`'s "one canonical config schema, DENY-LIST
 * boundaries" section argues for — `AgentConfigSchema` subtracts an explicit
 * `HOST_ONLY_AGENT_FIELDS` and `_internal-types.test.ts` asserts the remainder
 * is `never` — and it is the same failure mode: every field optional, so an
 * omission is valid TypeScript and presents as a working server quietly
 * ignoring part of its own configuration.
 *
 * So {@link ForwardingGap} is that subtraction. It resolves to `never` today,
 * and a member added to `RuntimeOptions` makes it that member's NAME — which is
 * a compile error at {@link assertNoForwardingGap} naming the field, with this
 * module as the place to either forward it or say why not.
 *
 * @module
 */

import type { AgentServerOptions } from "./agent-server.ts";
import type { RuntimeOptions } from "./runtime-types.ts";

/**
 * `RuntimeOptions` members this door deliberately does not carry, each with why.
 *
 * An entry here is a DECISION, not a backlog: adding one is how a new runtime
 * option opts out of the front door, and the reason has to be that no
 * self-hosted deployment can reach it through this shape — never that nobody
 * has asked yet, which is the reasoning the four gaps above were all shipped
 * under.
 *
 * **The list is checked in BOTH directions**, and the reverse one caught three
 * wrong entries on its first run: a first draft excused `name`, `greeting` and
 * `hostBaseAgent`, none of which is a `RuntimeOptions` member at all — the first
 * two are `ServerOptions` fields this door DERIVES from the agent, and the third
 * belongs to `createHostServer`'s own bag. Three plausible sentences about three
 * fields that were never in scope, which is exactly what a one-directional
 * deny-list accumulates. See {@link StaleExcuse}.
 */
export type UnforwardedRuntimeOption =
  /**
   * The PROVIDER triple. The agent declares these — `agent({ llm })` — and
   * `toAgentConfig` bakes them into the deployed config, so a server-level
   * override would be a second place to say what a deployed agent already
   * says, and the two could disagree.
   */
  | "stt"
  | "llm"
  | "tts"
  /**
   * The TESTING and SANDBOX seams. Every one replaces a piece of the engine
   * wholesale — the tool executor, the schemas it advertises, the sockets it
   * opens, the `run_code` sandbox, the egress `fetch`, the tool-result hook,
   * the guidance injected into a prompt, the one-shot generator — and a caller
   * filling one is embedding the runtime rather than serving an agent, which
   * is `createRuntime` + `createServer`. They are `@internal` or
   * platform-harness only.
   */
  | "executeTool"
  | "toolSchemas"
  | "createWebSocket"
  | "createOpenaiRealtimeWebSocket"
  | "runCode"
  | "fetch"
  | "onToolResult"
  | "toolGuidance"
  | "generate"
  | "workflows"
  /**
   * The TUNING numbers. Each is a default the framework enforces on its own
   * and no shipped deployment sets: a speech-to-speech config, the session
   * start deadline, the shutdown grace, the per-tool-call deadline. Forwarding
   * one would put a knob on the front door for a value nobody has needed to
   * move — the dead-config shape this repo keeps paying for.
   */
  | "s2sConfig"
  | "sessionStartTimeoutMs"
  | "shutdownTimeoutMs"
  | "toolTimeoutMs";

/**
 * Every `RuntimeOptions` member this door neither forwards nor excuses.
 *
 * `never` when the two lists cover the surface. Anything else is the name of an
 * option a self-hosted deployment cannot reach.
 */
export type ForwardingGap = Exclude<
  keyof RuntimeOptions,
  keyof AgentServerOptions | UnforwardedRuntimeOption
>;

/**
 * An excuse naming a member `RuntimeOptions` no longer has.
 *
 * `never` while every entry still names something. The direction a deny-list
 * ROTS in: an entry for a renamed or removed member goes on excusing a field
 * that does not exist, and the day a real gap appears the list looks maintained.
 */
export type StaleExcuse = Exclude<UnforwardedRuntimeOption, keyof RuntimeOptions>;

/**
 * An excuse for a member the door ALSO forwards.
 *
 * `never` while the two lists are disjoint. An entry here is an excuse that
 * stopped being true — somebody forwarded the option and left the reason
 * standing — and it reads as a decision.
 */
export type RedundantExcuse = Extract<UnforwardedRuntimeOption, keyof AgentServerOptions>;

/**
 * The three assertions, as DECLARATIONS rather than tests.
 *
 * Here and not in a `.test-d.ts` because this file is compiled by
 * `tsconfig.build.json` as well as by `typecheck` — so a gap fails a BUILD, not
 * only the test run, and cannot be missed by a filter that skipped tests. The
 * cost is three exported types nothing reads at run time; there is no value.
 *
 * Each takes its subject as a DEFAULTED parameter constrained to `never`, so
 * `never` satisfies it and anything else resolves to a string literal that does
 * not — reporting the offending member's name at the instantiation below.
 */
export type AssertNoForwardingGap<T extends never = ForwardingGap> = T;
export type AssertNoStaleExcuse<T extends never = StaleExcuse> = T;
export type AssertNoRedundantExcuse<T extends never = RedundantExcuse> = T;

/**
 * Instantiated so the constraints above are CHECKED rather than merely written.
 *
 * A declaration nothing instantiates checks nothing: the constraint on a type
 * parameter is verified where the parameter is FILLED, and these three lines are
 * what fill them. `agent-server-forwarding.test.ts` states the same claims in
 * the suite, with a message naming the field, which is what somebody adding a
 * runtime option actually reads.
 */
export type NoForwardingGap = AssertNoForwardingGap;
export type NoStaleExcuse = AssertNoStaleExcuse;
export type NoRedundantExcuse = AssertNoRedundantExcuse;
