// Copyright 2026 the AAI authors. MIT license.
/**
 * The one door from the runtime into the fast/slow feature.
 *
 * A module of its own rather than a few lines in `runtime.ts` for a mechanical
 * reason and a good one. The mechanical one: `runtime.ts` is at the 500-line
 * source cap, and this went over it. The good one is that
 * {@link createTwoTierWiring} answering `undefined` is the entire off-switch —
 * one `if` in one place — so the claim "an agent that declares no `twoTier`
 * allocates nothing and behaves exactly as it did" is checkable by reading this
 * file rather than by auditing call sites.
 *
 * ## Called from `setupTools`, and applied by SUBTRACTION
 *
 * Which tier gets which tools is a decision about the agent's tool SURFACE, so
 * it belongs where that surface is assembled — and, more pointedly, both
 * deployment paths have to make it identically. A deployed agent takes
 * `setupTools`' sandbox arm and `aai dev` the self-hosted one, which is exactly
 * the shape `guest-route-exposure` exists for: a gate wired on one arm works in
 * dev and silently does nothing in production.
 *
 * So the two arms answer `ToolSurface` — `ToolSetup` minus `tiers` — and
 * `setupTools` adds the split once over whichever came back. The subtraction is
 * the enforcement, the same move `ToolCallDefaults` makes on
 * `ExecuteToolCallOptions`: every other field on `ToolSetup` is optional, so an
 * arm that simply forgot would compile and hand the runtime an `undefined`
 * split on one of the two paths.
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { ExecuteTool, ProviderEnv } from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { Logger } from "../runtime-config.ts";
import type { Transport } from "../transports/types.ts";
import type { UsageMeter } from "../usage-meter.ts";
import { resolveTwoTier } from "./resolve.ts";
import { openTwoTierSession, type TwoTierSession } from "./session.ts";
import { createSlowLoop } from "./slow-loop.ts";

/** What one session's bridge is opened with. @internal */
export type TwoTierOpenArgs = {
  sessionId: string;
  usage: UsageMeter;
  /**
   * The session's transport, narrowed to the ONE verb the bridge uses.
   *
   * `() => Transport` is assignable to this and is what the caller passes, so
   * nothing at the call site changes — what the narrowing buys is that a spec
   * can supply `{}`, and that the bridge's reach into the transport is stated
   * in its own signature rather than discovered by reading the body.
   */
  transport: () => Pick<Transport, "injectTurn">;
  instructions: () => string;
};

/** Opens the bridge for one session. @internal */
export type TwoTierOpener = (args: TwoTierOpenArgs) => TwoTierSession;

/**
 * What {@link createTwoTierWiring} needs from the runtime — and it is exactly
 * `ToolSetupDeps`' own members, structurally.
 *
 * That is not a coincidence, it is why this is called from `setupTools`: which
 * tier gets which tools is a decision about the agent's TOOL SURFACE, and
 * `setupTools` is where that surface is assembled. Reading `agent` rather than
 * the serialized `AgentConfig` is the other half — both `twoTier` and
 * `builtinTools` are on the declaration, so this needs nothing the tool setup
 * did not already have.
 *
 * @internal
 */
export type CreateTwoTierOpenerDeps = {
  agent: AgentDef;
  /** The agent's EFFECTIVE LLM, which is the slow tier's fallback descriptor. */
  llm: LlmProvider | undefined;
  /** Provider credentials — the slow tier dials a model, so it needs these. */
  providerEnv: ProviderEnv;
  logger: Logger;
};

/** The half of {@link ToolSetup} this reads. @internal */
export type TwoTierToolSurface = {
  /** The agent's own tool schemas — what the fast tier would otherwise be given. */
  toolSchemas: ToolSchema[];
  /** The runtime's own executor, unchanged: one tool call, fully contextual. */
  executeTool: ExecuteTool;
};

/**
 * Everything the runtime has to decide differently when a second tier exists.
 *
 * THREE answers rather than one, and they are together because they are one
 * decision: with a second tier the fast one has no tools, and a prompt that
 * still explains tools to it describes a surface it does not have. Returning
 * them separately let `runtime.ts` honour one and forget another — and the
 * failure mode of forgetting either is a 400 per turn or a model narrating
 * calls it cannot make, neither of which names this feature in its message.
 *
 * @internal
 */
export type TwoTierWiring = {
  /** `undefined` when the agent declared none. That is the whole off-switch. */
  readonly open: TwoTierOpener | undefined;
  /**
   * What the fast tier's transport is given: nothing, or the agent's own.
   *
   * Mutable rather than `readonly`, matching `TransportFactoryDeps.toolSchemas`
   * — the transport's own declaration, which this feeds. Narrowing it here
   * would only push a cast into `runtime.ts`.
   */
  readonly fastToolSchemas: ToolSchema[];
  /** Whether the fast tier's base prompt should explain tools. */
  readonly fastHasTools: boolean;
};

/**
 * Decide the three, for one runtime.
 *
 * @internal
 */
export function createTwoTierWiring(
  deps: CreateTwoTierOpenerDeps,
  surface: TwoTierToolSurface,
): TwoTierWiring {
  const config = resolveTwoTier(deps.agent.twoTier);
  const hasOwnTools = surface.toolSchemas.length > 0 || (deps.agent.builtinTools?.length ?? 0) > 0;
  if (config === undefined) {
    return { open: undefined, fastToolSchemas: surface.toolSchemas, fastHasTools: hasOwnTools };
  }
  const open = (args: TwoTierOpenArgs): TwoTierSession =>
    openTwoTierSession({
      config,
      agentSchemas: surface.toolSchemas,
      instructions: args.instructions,
      transport: args.transport,
      sessionId: args.sessionId,
      logger: deps.logger,
      // The runtime's OWN executor, with the session id and an empty message
      // list. Empty because the slow tier's tools see no conversation by
      // design (`slow-loop.ts`) — its view of the call is the brief, rebuilt
      // per run from session state, which is the information boundary stated
      // as a default rather than as a rule somebody follows.
      runTool: (name, toolArgs, signal) =>
        surface.executeTool(name, toolArgs, args.sessionId, [], { signal }),
      slowLoop: (session) =>
        createSlowLoop({
          llm: config.llm,
          fallbackLlm: deps.llm,
          env: deps.providerEnv,
          effort: config.effort,
          maxSteps: config.maxSteps,
          timeoutMs: config.timeoutMs,
          sessionId: args.sessionId,
          logger: deps.logger,
          schemas: session.schemas,
          executeTool: session.executeTool,
          ...omitUndefined({ usage: args.usage }),
        }),
    });
  return { open, fastToolSchemas: [], fastHasTools: false };
}
