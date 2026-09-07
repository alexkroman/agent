// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 30.
 *
 * The spec a template writes for a stateful tool: a context built by
 * {@link createToolContext}, a subagent faked by {@link stubDelegate}, and the
 * unwrap helpers that read a gated result. Written the way it was authored at
 * epoch 30, and it must keep compiling for as long as that epoch is advertised
 * as supported.
 *
 * ## What moved, and why epoch 30 survives it
 *
 * The export list is unchanged; the report moved for two SIGNATURES that reach
 * it:
 *
 * - `ToolContext` gained `deadlineAt`, and `createToolContext` supplies it. A
 *   spec that overrides nothing gets the runtime's own default deadline from
 *   now, so {@link driveOnce} below — which overrides nothing — is unaffected.
 *   That is the whole point of the helper existing: a hand-rolled context stub
 *   would have gone stale here, which is what its own doc says it is for.
 * - `DelegateFn` became OVERLOADED, so a subagent declaring a `schema` answers
 *   with a parsed `object`. `stubDelegate` scripts a subagent that declares
 *   none, which selects the plain overload and returns the same
 *   `DelegateResult` it always did.
 *
 * Nothing here declares a schema, deliberately: this file is evidence about
 * epoch 30's surface, not a demonstration of the newer one.
 */

import { z } from "zod";
import { type AgentDef, agent, sessionSlot, subagent, tool } from "../../../index.ts";
import {
  createToolContext,
  dialogResultSchema,
  expectToolOk,
  type SentEvent,
  type StubDelegateCall,
  stubDelegate,
  type TestToolContext,
} from "../../../sdk/testing.ts";

const notesSlot = sessionSlot("notes", () => ({ lines: [] as string[] }));

const summarizer = subagent({
  name: "summarizer",
  systemPrompt: "Summarize the note in one sentence.",
  expectedOutput: "One sentence.",
});

const addNote = notesSlot.updateTool({
  description: "Write a note.",
  inputSchema: z.object({ line: z.string() }),
  execute({ line }, notes) {
    notes.lines.push(line);
    return { kept: notes.lines.length };
  },
});

const summarize = tool({
  description: "Summarize what has been written.",
  inputSchema: z.object({}),
  async execute(_args, ctx) {
    const answer = await ctx.delegate(summarizer, { task: notesSlot.get(ctx).lines.join(" ") });
    ctx.send("summary", { text: answer.text });
    return { summary: answer.text, steps: answer.steps, accepted: answer.accepted };
  },
});

/** A tool is declared by its FILE, so a spec drives the def it imported. */
const deskAgent: AgentDef = agent({ name: "Notes" });

/**
 * Drive both tools against ONE session, and report what the spec would assert.
 *
 * The context is defaulted end to end: no `env`, no `deadlineAt`, a slot store
 * of its own, and a `send` that records into {@link TestToolContext.sent}.
 */
export async function driveOnce(): Promise<{
  kept: number;
  summary: string;
  sent: readonly SentEvent[];
  calls: readonly StubDelegateCall[];
}> {
  const desk = stubDelegate({ summarizer: "They asked about the roof." });
  const ctx: TestToolContext = createToolContext({ delegate: desk.delegate });

  // The def is called directly: `tools/` declares the tool, so a spec that
  // imported the module already holds it.
  const first = expectToolOk<{ kept: number }>(
    await addNote.execute({ line: "The roof leaks." }, ctx),
  );
  const second = expectToolOk<{ summary: string }>(await summarize.execute({}, ctx));

  return {
    kept: first.kept,
    summary: second.summary,
    sent: ctx.sent,
    calls: desk.calls,
  };
}

/**
 * The envelope a GATED tool answers with, asked of the SDK rather than restated.
 *
 * A spec holding a serialized result parses it with this; the shape is the
 * dialog's, so a template that stopped carrying its position fails naming the
 * field instead of reading `undefined` three assertions later.
 */
export const StagedResult = dialogResultSchema(z.object({ held: z.number() }));

/** The agent a starter spec names, kept so the def is exercised. */
export const frozenAgent = deskAgent;

/** A second session is a second slot store — the isolation a spec relies on. */
export function twoSessionsAreIsolated(): boolean {
  const a = createToolContext();
  const b = createToolContext();
  return notesSlot.get(a).lines !== notesSlot.get(b).lines && a.sessionId !== b.sessionId;
}
