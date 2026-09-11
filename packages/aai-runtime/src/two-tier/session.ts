// Copyright 2026 the AAI authors. MIT license.
/**
 * One session's two-tier bridge: the digest, the gated tool surface, and the
 * one thing that wakes the slow tier.
 *
 * This is where the three couplings meet, and each is a piece of plumbing this
 * runtime already had rather than a channel invented for the feature:
 *
 * | TalkAct | here |
 * | --- | --- |
 * | `digest` on `SharedState` | {@link DigestStore}, rendered into the fast tier's prompt SUFFIX — the same seam `dialog()` uses, for the same reason |
 * | `fast_to_slow` queue + `@slow:` directives | the session's own transcript. `user-transcript.committed` wakes the slow tier, which re-reads the conversation |
 * | `slow_to_fast` queue | `Transport.injectTurn`, the verb that already existed for "a durable run finished, tell the caller" |
 * | `interrupt_event` | `createCoalescingRunner` — a caller who says three things during one slow step gets ONE follow-up run over the latest state |
 *
 * ## The wake is the runtime's, not the fast tier's
 *
 * TalkAct's fast agent must emit `@slow: <what the user said>` or the
 * information never reaches the browser, and their ablation shows what that is
 * worth: with the channel removed, task success is **0/4**. It is also the one
 * part of the contract that depends on a small model following a text protocol,
 * and their own parser carries three regexes to strip the scaffolding small
 * models echo into speech instead.
 *
 * Here the runtime hears the caller directly, so the relay is unconditional and
 * the fast tier is asked for no protocol at all. That is what makes a tool-free
 * conversational model viable rather than merely tolerable.
 */

import type { Message } from "@alexkroman1/aai";
import { createCoalescingRunner } from "@alexkroman1/aai/internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { pushCapped } from "@alexkroman1/aai/utils";
import type { Logger } from "../runtime-config.ts";
import { CHANNEL_TOOLS, channelToolSchemas, withSummaryArg } from "./channel.ts";
import { createDigestStore, type DigestStore } from "./digest.ts";
import { renderDigestSection } from "./digest-prompt.ts";
import { createGatedExecutor } from "./gate.ts";
import type { ResolvedTwoTier } from "./resolve.ts";
import type { SlowLoop } from "./slow-loop.ts";
import { classifyToolSchema, slowTierViewOf, type ToolCatalogEntry } from "./view.ts";

/** What one session's bridge exposes. @internal */
export type TwoTierSession = {
  /**
   * The digest, rendered for the fast tier's prompt — install as its suffix.
   *
   * A THUNK, because the suffix seam resolves per request: a digest that moved
   * between two turns reaches the second one without anybody pushing it.
   */
  promptSection(): string;
  /**
   * Offer a session event. Wakes the slow tier on a committed caller utterance
   * and on nothing else.
   */
  observe(event: SessionEvent): void;
  /** The slow tier's tool schemas — the agent's, plus the three channel tools. */
  readonly schemas: readonly ToolSchema[];
  /** The gated executor the slow loop is built with. */
  executeTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<string>;
  /** Abort an in-flight run. Called when the session releases. */
  stop(): void;
  /** Test seam: the digest as it stands. */
  digest(): DigestStore;
};

/** What {@link openTwoTierSession} needs. @internal */
export type OpenTwoTierSessionOptions = {
  config: ResolvedTwoTier;
  /** The agent's own tool schemas — what the FAST tier would have been given. */
  agentSchemas: readonly ToolSchema[];
  /**
   * The agent's own instructions — `SystemPromptResolver.base()`.
   *
   * The BASE rather than the resolved prompt, for two reasons. The resolved one
   * already contains the digest section this feature installs, so the slow tier
   * would be reading its own last summary back as part of its instructions. And
   * `base()` is the day-cached string, so asking for it per run costs a map
   * lookup. The gap it leaves is honest and worth knowing: an agent whose
   * `systemPrompt` is a RESOLVER puts nothing on the wire for it, so the slow
   * tier sees the voice sections and not the per-session text — the same
   * limitation `S2sSessionConfig.systemPrompt` records for its own reason.
   */
  instructions: () => string;
  /** How the slow tier speaks: the session's transport. */
  transport: () => { injectTurn?(instruction: string): void };
  /**
   * Runs one agent tool. The session's OWN `ExecuteTool`, so a slow-tier call
   * gets argument coercion, schema validation, the real `ToolContext`, the
   * per-call deadline and `ToolDef.onError` — everything a fast-tier call used
   * to get, unchanged.
   */
  runTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<string>;
  /** Built from {@link TwoTierSession.schemas} and {@link TwoTierSession.executeTool}. */
  slowLoop: (session: TwoTierSession) => SlowLoop;
  logger: Logger;
  sessionId: string;
};

/**
 * How many transcript lines the accumulated conversation keeps.
 *
 * Larger than `contextMessages`, which is the WINDOW handed to one run — this
 * is the buffer the window is taken from, and it bounds the session's memory
 * for a long call. `pushCapped` drops the oldest.
 */
const MAX_CONVERSATION = 200;

/**
 * Open the bridge for one session.
 *
 * @internal
 */
export function openTwoTierSession(options: OpenTwoTierSessionOptions): TwoTierSession {
  const { config, agentSchemas, logger, sessionId } = options;
  const digest = createDigestStore();
  const abort = new AbortController();

  // The slow tier's surface: the agent's tools plus the three channel ones,
  // every schema carrying the mandatory `state_summary`.
  const channels = channelToolSchemas();
  const wrapped: ToolSchema[] = [];
  const catalog = new Map<string, ToolCatalogEntry>();
  const undeclared: string[] = [];
  const summaryless: string[] = [];
  for (const schema of [...agentSchemas, ...channels]) {
    const { schema: next, carriesSummary } = withSummaryArg(schema);
    wrapped.push(next);
    catalog.set(schema.name, classifyToolSchema(schema));
    if (!carriesSummary) summaryless.push(schema.name);
    // The agent's own tools only. `tell_user` and `ask_user` are the
    // framework's and are read-only by construction, so naming them in a
    // warning an AUTHOR reads is noise in exactly the line that has to be
    // worth reading — this reported all three on its first run.
    if (
      !CHANNEL_TOOLS.includes(schema.name) &&
      schema.mutates === undefined &&
      schema.completes === undefined
    ) {
      undeclared.push(schema.name);
    }
  }
  // Announced ONCE per session rather than inferred, because absence of the
  // declaration is the one thing the gate cannot distinguish from a read. An
  // author who forgot `mutates: true` should find out from a line here rather
  // than from a benchmark result they cannot explain.
  if (undeclared.length > 0) {
    logger.warn("twoTier: tools with no `mutates` declaration are treated as reads", {
      sid: sessionId,
      tools: undeclared,
    });
  }
  if (summaryless.length > 0) {
    logger.warn("twoTier: tools already taking `state_summary` carry no digest obligation", {
      sid: sessionId,
      tools: summaryless,
    });
  }

  const session: TwoTierSession = {
    promptSection: () => renderDigestSection(digest.read()),
    // Late-bound. `createCoalescingRunner` below needs the session to build the
    // loop, and the loop needs the session's executor — so one of the two has
    // to be filled in afterwards, and this is the one nothing reads before the
    // first session event arrives. The body is deliberately empty rather than
    // absent: `observe` is not optional on the type, and a `?.` at the one call
    // site would make "not wired yet" and "no bridge" the same thing.
    observe: () => undefined,
    schemas: wrapped,
    // One call's whole DECISION — see `gate.ts`.
    executeTool: createGatedExecutor({
      digest,
      catalog,
      completionGate: config.completionGate,
      transport: options.transport,
      runTool: options.runTool,
      logger,
      sessionId,
    }),
    stop: () => abort.abort(),
    digest: () => digest,
  };

  // The conversation, accumulated from the session's OWN transcript events.
  //
  // Rebuilt here rather than borrowed from the transport, and that is the
  // information boundary again: what this holds is exactly what the caller said
  // and what the agent said back — the two events a client also receives — so
  // there is no richer history to reach for even by accident. It is also the
  // only view available: with `twoTier` on, the fast tier has no tools, so
  // nothing hands the runtime a `ctx.messages` from a tool call any more.
  const conversation: Message[] = [];

  const loop = options.slowLoop(session);
  // ONE run at a time, with at most one follow-up queued however many
  // utterances arrive during it — and the follow-up re-reads the conversation
  // rather than carrying a payload, which is exactly why the collapse is safe.
  const runner = createCoalescingRunner(async () => {
    if (abort.signal.aborted) return;
    const view = slowTierViewOf(
      {
        instructions: options.instructions(),
        messages: conversation,
        toolSchemas: agentSchemas,
      },
      digest.read(),
      config.contextMessages,
    );
    await loop(view, abort.signal);
  });

  session.observe = (event: SessionEvent): void => {
    if (event.type === "agent-transcript.committed") {
      pushCapped(conversation, { role: "assistant", content: event.text }, MAX_CONVERSATION);
      return;
    }
    // The ONE wake. Not `agent-transcript.committed` above (the fast tier's own
    // words are in the conversation the next run reads, and waking on them
    // would run the slow tier against its own narration — including the turn
    // `injectTurn` just caused, which is a loop), and not `tool.completed`
    // (those are the slow tier's own calls).
    if (event.type !== "user-transcript.committed") return;
    pushCapped(conversation, { role: "user", content: event.text }, MAX_CONVERSATION);
    void runner.trigger().catch((err: unknown) => {
      // A rejection here has already been classified by the loop, which
      // answers an outcome rather than throwing; anything reaching this is the
      // runner itself. It must not propagate — `observe` is called from event
      // dispatch on a live call.
      logger.warn("twoTier: slow tier run rejected", {
        sid: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  return session;
}
