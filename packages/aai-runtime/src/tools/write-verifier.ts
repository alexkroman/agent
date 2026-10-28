// Copyright 2026 the AAI authors. MIT license.
/**
 * A second look before a write runs: does this call do exactly what the
 * caller asked for and agreed to, on the records as fetched?
 *
 * Opt-in (`agent({ writes: { verify: true } })`). On a 114-task tau2-bench
 * retail run, 35 of 61 missed writes reached a write with the wrong variant,
 * order, action type or item set — reasoning over records the agent had
 * already fetched — and 33 writes nobody asked for went through besides. The
 * model that chose the call is the worst-placed to catch it mid-turn, so a
 * separate call asks only this question, with no tools and no turn to finish.
 *
 * Generic by construction: it sees what every agent has — its own instructions,
 * the conversation (caller turns, its replies, tool results) and the planned
 * call with the tool's description — and nothing domain-specific.
 *
 * It ADVISES, it does not block indefinitely:
 * - A refusal must name a specific mismatch, quoting the caller or citing a
 *   record. Anything vaguer passes.
 * - The same call (tool + arguments) refused once runs the second time: the
 *   model heard the objection and kept its choice.
 * - A timeout, an unparseable verdict, or any error passes: an unavailable
 *   checker must never be what stops a write.
 */

import type { Message } from "@alexkroman1/aai";
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { errorMessage } from "@alexkroman1/aai/utils";
import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import type { Logger } from "../logger.ts";
import { writeToolNames } from "./confirmation-gate.ts";

/** The check is abandoned (and the write runs) past this. @internal */
export const WRITE_VERIFY_TIMEOUT_MS = 6000;
/** Transcript budget: the most recent characters of the conversation. @internal */
const TRANSCRIPT_CHARS = 24_000;
/** A single tool result is cut to this many characters in the transcript. */
const RESULT_CHARS = 3000;

/** @internal */
export type WriteVerdict = { ok: true } | { ok: false; mismatch: string };

const VERDICT_SCHEMA = jsonSchema<{ verdict: "ok" | "mismatch"; mismatch?: string }>({
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ok", "mismatch"] },
    mismatch: { type: "string" },
  },
  required: ["verdict"],
  additionalProperties: false,
});

/** The conversation as plain text, newest last, within the budget. @internal */
export function transcriptOf(messages: readonly Message[]): string {
  const lines = messages.map((m) => {
    if (m.role === "user") return `CALLER: ${m.content}`;
    if (m.role === "assistant") return `AGENT: ${m.content}`;
    if (m.role === "tool")
      return `RESULT of ${m.toolName ?? "tool"}: ${m.content.slice(0, RESULT_CHARS)}`;
    return `${m.role.toUpperCase()}: ${m.content}`;
  });
  const text = lines.join("\n");
  return text.length > TRANSCRIPT_CHARS ? `…${text.slice(-TRANSCRIPT_CHARS)}` : text;
}

/** The prompt for one check. @internal */
export function verifierPrompt(input: {
  instructions: string;
  transcript: string;
  tool: ToolSchema;
  args: Readonly<Record<string, unknown>>;
}): string {
  return [
    "You check one action a voice agent is about to take, before it runs. The action",
    "changes something the caller cannot take back by asking.",
    "",
    "Answer `mismatch` ONLY if you can name a specific contradiction, quoting the caller",
    "or citing a value from a RESULT line: the wrong record (order, account, item), the",
    "wrong kind of action (e.g. return instead of exchange), a choice that ignores what",
    "the caller said must hold or may change (e.g. not the cheapest available option",
    "when they asked for the cheapest), something the caller never asked for, a payment",
    "or value they did not agree to, or a step the agent's instructions forbid. Otherwise",
    "answer `ok` — including when you are merely unsure. Transcripts come from speech",
    "recognition: a misheard word is not a mismatch if the meaning is clear.",
    "",
    "AGENT INSTRUCTIONS:",
    input.instructions,
    "",
    "CONVERSATION SO FAR:",
    input.transcript,
    "",
    "PLANNED ACTION:",
    `${input.tool.name}: ${input.tool.description}`,
    `arguments: ${JSON.stringify(input.args)}`,
    "",
    "Reply with verdict `ok` or `mismatch`; for `mismatch`, one sentence naming it.",
  ].join("\n");
}

/** Run one check. Never throws: every failure is a pass. @internal */
export async function verifyWrite(deps: {
  model: LanguageModel;
  instructions: string;
  messages: readonly Message[];
  tool: ToolSchema;
  args: Readonly<Record<string, unknown>>;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}): Promise<WriteVerdict> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? WRITE_VERIFY_TIMEOUT_MS);
  const abortSignal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  try {
    const { output } = await generateText({
      model: deps.model,
      output: Output.object({ schema: VERDICT_SCHEMA }),
      abortSignal,
      prompt: verifierPrompt({
        instructions: deps.instructions,
        transcript: transcriptOf(deps.messages),
        tool: deps.tool,
        args: deps.args,
      }),
    });
    const mismatch = output.mismatch?.trim();
    return output.verdict === "mismatch" && mismatch ? { ok: false, mismatch } : { ok: true };
  } catch {
    return { ok: true };
  }
}

/** What the model is told when a check finds a mismatch. @internal */
export function mismatchResult(mismatch: string): string {
  return (
    "Not done yet, and nothing was changed. A check of this action against the conversation " +
    `found: ${mismatch} Fix the call if that is right — or, if your call was correct, make ` +
    "the same call again and it will run."
  );
}

/**
 * Wrap `executeTool` so each declared write (`readOnlyHint: false`) is checked
 * first. With no declared writes it returns `executeTool` itself.
 *
 * @internal
 */
export function withWriteVerification(
  executeTool: ExecuteTool,
  deps: {
    schemas: readonly ToolSchema[];
    check: (tool: ToolSchema, args: Readonly<Record<string, unknown>>) => Promise<WriteVerdict>;
    log: Logger;
    sid: string;
  },
): ExecuteTool {
  const writes = writeToolNames(deps.schemas);
  if (writes.size === 0) return executeTool;
  const byName = new Map(deps.schemas.map((s) => [s.name, s]));
  // Calls refused once, by tool + arguments: the second identical call runs.
  const refused = new Set<string>();
  return async (name, args, sessionId, messages, options) => {
    const tool = byName.get(name);
    if (tool !== undefined && writes.has(name)) {
      const key = `${name}:${JSON.stringify(args)}`;
      if (!refused.has(key)) {
        const verdict = await deps.check(tool, args).catch((err: unknown) => {
          deps.log.warn("Write check failed; running the write", {
            sid: deps.sid,
            error: errorMessage(err),
          });
          return { ok: true } as const;
        });
        if (!verdict.ok) {
          refused.add(key);
          deps.log.info("Pipeline write held by check", {
            sid: deps.sid,
            tool: name,
            mismatch: verdict.mismatch,
          });
          return mismatchResult(verdict.mismatch);
        }
      }
    }
    return executeTool(name, args, sessionId, messages, options);
  };
}
