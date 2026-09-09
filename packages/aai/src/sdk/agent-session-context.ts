// Copyright 2026 the AAI authors. MIT license.
/**
 * What a per-session author FUNCTION is handed — the one context shared by
 * every `agent()` field that is a callback rather than a value.
 *
 * There are three of them now ({@link AgentDef.systemPrompt} as a resolver,
 * {@link AgentDef.inputGuardrails}, {@link AgentDef.outputGuardrails}) and they
 * want the same three things: which session this is, the agent's environment,
 * and the session's own slot state. Declared once here rather than three times,
 * because three copies of a context is three chances for one of them to gain a
 * capability the others were deliberately denied.
 *
 * **It is deliberately the same shape as `SessionEventContext`** and carries
 * the same omissions for the same reason: no `send`, no `generate`, no
 * `delegate`, no `messages`. None of these functions may SPEAK. A resolver
 * returns instructions and a guardrail returns a verdict; anything else they
 * could do to the turn would make a declaration into a second control path, and
 * the value of a declaration is that a reader can see what it does.
 *
 * The two are not unified into one exported name because they are read by
 * different audiences and their docs argue different things — a handler's
 * context explains why observing may not become driving, and this one explains
 * what a resolver is allowed to know, down to the per-field level (`slots` here
 * warns that a resolver runs on every request; over there it warns that a
 * handler's write is committed only after it returns). An alias would make one
 * of those two pages disappear.
 *
 * **They must not DRIFT, and that is CHECKED rather than asked for.**
 * `define.test-d.ts` asserts mutual assignability and equal key sets in both
 * directions, so a capability added to one is a compile error until it is added
 * to the other or the pin is deliberately edited. It used to be this paragraph
 * alone, which states the burden without carrying any of it.
 */

import type { SlotStore } from "./session-state.ts";

/**
 * The session a per-session author function is running for.
 *
 * @public
 */
export interface AgentSessionContext {
  /** The session this call belongs to — the id a stream read is keyed by. */
  sessionId: string;
  /**
   * Environment variables available to this agent (from `.env` under
   * `aai dev`, `aai secret` in production) — the same view a tool reads as
   * `ctx.env`.
   */
  // `Partial` for the same reason as `ToolContext.env`: a variable that was
  // never set is `undefined` however the type reads.
  env: Readonly<Partial<Record<string, string>>>;
  /**
   * This session's slot storage — **reach for {@link sessionSlot}, not this**,
   * exactly as in a tool. It is on the context because a slot declared in one
   * module has no other way to find the session.
   *
   * Reading it is the point: a prompt that cannot see the session's state is a
   * constant with extra steps, and a guardrail that cannot count strikes can
   * only judge one sentence at a time. Writing works too and lands like any
   * other slot write — but a resolver runs on every request, so a resolver that
   * writes is writing several times a turn.
   */
  slots: SlotStore;
}
