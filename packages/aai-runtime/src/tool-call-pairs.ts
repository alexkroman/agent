// Copyright 2026 the AAI authors. MIT license.
/**
 * Every assistant tool call in a model history has a result, and every result
 * answers a call. The one guard that keeps a history in that shape.
 *
 * **Why a history can break it at all.** The AI SDK builds a step's messages
 * from what the step actually did: an assistant message with the `tool-call`
 * parts the model emitted, then a `tool` message with one result per call the
 * SDK EXECUTED. Since ai@7.0.70 it executes a tool call only when the model
 * call finished with `stop` or `tool-calls` ("Prevent automatic tool execution
 * when a model call ends with an unsafe finish reason"). A step that ends with a
 * tool call and `length`, `other`, `content-filter` or `error` — a gateway that
 * omits `finish_reason` maps to `other` — executes nothing, and its messages
 * are the assistant call ALONE. Persist those, and every later request in the
 * session is refused before it leaves the process:
 * `Tool result is missing for tool call <id>.` (the SDK's own
 * `MissingToolResultsError`, raised while converting the prompt). A tau2 retail
 * session hit exactly that and failed eight turns in a row until the caller
 * hung up — nothing in it could ever recover, because the broken message was in
 * history and history is what every request is built from.
 *
 * The mirror image — a `tool` result with no call ahead of it — is rejected by
 * the providers themselves (OpenAI: "messages with role 'tool' must be a
 * response to a preceding message with 'tool_calls'"). The history's front trim
 * already heals the one shape of it that trimming makes (`capLlm`,
 * `pipeline-history.ts`); this guard covers the rest.
 *
 * **The rules match the SDK's own check, not a stricter one.** A call is
 * answered by a result anywhere after it and before the next `user` or
 * `system` message — the window `MissingToolResultsError` is computed over —
 * so a history the SDK would accept is never rewritten. Provider-executed
 * calls are skipped for the same reason: the SDK does not require a result
 * for them.
 *
 * - An UNANSWERED call gets a synthetic result, placed after the `tool`
 *   messages that directly follow its assistant message (or right after the
 *   assistant message when there are none), carrying
 *   {@link UNEXECUTED_TOOL_CALL_ERROR} as an error. That tells the model the
 *   truth — it asked, and nothing ran — so the next turn can call again rather
 *   than believe the action happened.
 * - An ORPHANED result (no call earlier in its window) is dropped, and a `tool`
 *   message left empty goes with it.
 *
 * Idempotent: a repaired history has nothing left to repair. And cheap on the
 * common path: a history that needs nothing comes back as the SAME array.
 */

import type { ModelMessage, ToolModelMessage } from "ai";
import type { Logger } from "./runtime-config.ts";

/** The error a synthetic result carries — the model reads this. */
export const UNEXECUTED_TOOL_CALL_ERROR = "This tool call was not executed.";

/** One change {@link pairToolCalls} made. */
export interface ToolPairRepair {
  /** `orphan-call`: a synthetic result was added. `orphan-result`: a result was dropped. */
  readonly kind: "orphan-call" | "orphan-result";
  readonly toolCallId: string;
  readonly toolName: string;
}

/** A history, paired, and what it took. */
export interface PairedHistory {
  /** The input array itself when {@link repairs} is empty. */
  readonly messages: readonly ModelMessage[];
  readonly repairs: readonly ToolPairRepair[];
}

type Call = { readonly toolCallId: string; readonly toolName: string };

/** A `user` or `system` message closes the window results may answer in. */
function closesWindow(m: ModelMessage): boolean {
  return m.role === "user" || m.role === "system";
}

/** The client-executed tool calls an assistant message makes. */
function callsOf(m: ModelMessage): Call[] {
  if (m.role !== "assistant" || typeof m.content === "string") return [];
  const calls: Call[] = [];
  for (const part of m.content) {
    if (part.type !== "tool-call" || part.providerExecuted === true) continue;
    calls.push({ toolCallId: part.toolCallId, toolName: part.toolName });
  }
  return calls;
}

/** The call ids a `tool` message answers. */
function resultIdsOf(m: ModelMessage): string[] {
  if (m.role !== "tool") return [];
  return m.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []));
}

/**
 * Every call that IS answered, keyed by window so an id reused in a later
 * window cannot borrow an earlier window's result.
 */
function answeredCalls(messages: readonly ModelMessage[]): Set<string> {
  const answered = new Set<string>();
  let window = 0;
  let called = new Set<string>();
  for (const m of messages) {
    if (closesWindow(m)) {
      window++;
      called = new Set();
      continue;
    }
    for (const call of callsOf(m)) called.add(call.toolCallId);
    for (const id of resultIdsOf(m)) if (called.has(id)) answered.add(`${window}:${id}`);
  }
  return answered;
}

/** The synthetic answer for calls nothing executed. */
function unexecuted(calls: readonly Call[]): ToolModelMessage {
  return {
    role: "tool",
    content: calls.map((call) => ({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { type: "error-json", value: { error: UNEXECUTED_TOOL_CALL_ERROR } },
    })),
  };
}

/**
 * `m` without the results whose call is not in `called`, or `null` when
 * nothing is left. Answers `m` itself when every result is kept.
 */
function withoutOrphanResults(
  m: ToolModelMessage,
  called: ReadonlySet<string>,
  repairs: ToolPairRepair[],
): ToolModelMessage | null {
  const content = m.content.filter((part) => {
    if (part.type !== "tool-result" || called.has(part.toolCallId)) return true;
    repairs.push({ kind: "orphan-result", toolCallId: part.toolCallId, toolName: part.toolName });
    return false;
  });
  if (content.length === m.content.length) return m;
  return content.length === 0 ? null : { ...m, content };
}

/** The walk's running state — see {@link pairToolCalls}. */
interface PairWalk {
  readonly answered: ReadonlySet<string>;
  readonly out: ModelMessage[];
  readonly repairs: ToolPairRepair[];
  window: number;
  /** Calls made so far in this window — what a result may answer. */
  called: Set<string>;
  /** Unanswered calls whose synthetic result is still to be placed. */
  owed: Call[];
}

/** Place the owed results — after the `tool` run that follows their call. */
function settleOwed(walk: PairWalk): void {
  if (walk.owed.length === 0) return;
  walk.out.push(unexecuted(walk.owed));
  walk.owed = [];
}

/** One message of the walk. */
function visit(walk: PairWalk, m: ModelMessage): void {
  if (m.role === "tool") {
    const kept = withoutOrphanResults(m, walk.called, walk.repairs);
    if (kept !== null) walk.out.push(kept);
    return;
  }
  settleOwed(walk);
  walk.out.push(m);
  if (closesWindow(m)) {
    walk.window++;
    walk.called = new Set();
    return;
  }
  for (const call of callsOf(m)) {
    walk.called.add(call.toolCallId);
    if (walk.answered.has(`${walk.window}:${call.toolCallId}`)) continue;
    walk.owed.push(call);
    walk.repairs.push({ kind: "orphan-call", ...call });
  }
}

/** Pair every tool call with a result — see the module doc. */
export function pairToolCalls(messages: readonly ModelMessage[]): PairedHistory {
  const walk: PairWalk = {
    answered: answeredCalls(messages),
    out: [],
    repairs: [],
    window: 0,
    called: new Set(),
    owed: [],
  };
  for (const m of messages) visit(walk, m);
  settleOwed(walk);
  const { out, repairs } = walk;
  return repairs.length === 0 ? { messages, repairs } : { messages: out, repairs };
}

/**
 * {@link pairToolCalls}, logging each repair once. The one door every caller
 * goes through, so the log line is the same wherever a history was mended.
 */
export function pairToolCallsLogged(
  messages: readonly ModelMessage[],
  log: Pick<Logger, "warn">,
  sid: string,
): readonly ModelMessage[] {
  const paired = pairToolCalls(messages);
  for (const repair of paired.repairs) {
    const what =
      repair.kind === "orphan-call"
        ? "Orphaned tool call repaired"
        : "Orphaned tool result dropped";
    log.warn(what, { sid, toolCallId: repair.toolCallId, toolName: repair.toolName });
  }
  return paired.messages;
}

const NO_WARN: Pick<Logger, "warn"> = { warn: () => undefined };

/**
 * {@link pairToolCallsLogged} over a history the caller OWNS, rewritten in
 * place — the pipeline's LLM view, which the rest of the transport holds by
 * reference. Touches nothing when nothing needs pairing.
 */
export function pairToolCallsInPlace(
  messages: ModelMessage[],
  log: Pick<Logger, "warn"> | undefined,
  sid: string | undefined,
): void {
  const paired = pairToolCallsLogged(messages, log ?? NO_WARN, sid ?? "");
  if (paired !== messages) messages.splice(0, messages.length, ...paired);
}
