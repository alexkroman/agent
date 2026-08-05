// Copyright 2026 the AAI authors. MIT license.
/**
 * Machinery for the pipeline transport's randomized interleaving fuzz
 * (`pipeline-fuzz.integration.test.ts`): the LLM request-payload validator and
 * the stream-lifetime probe. fast-check supplies the randomness now, so there is
 * no PRNG here.
 *
 * Kept out of the spec so each piece stays small enough to read on its own, and
 * so the spec is the oracles and the generator rather than their plumbing.
 *
 * @internal Test infrastructure, not part of any public API.
 */

/** Collapse whitespace so a text comparison is about content, not chunking. */
export function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** One message of a `LanguageModelV3` prompt, as far as the oracle cares. */
export interface PromptMsg {
  role: string;
  content: unknown;
}

interface ToolIds {
  called: Map<string, number>;
  resulted: Map<string, number>;
}

/** Index every tool-call and tool-result id in a prompt by message position. */
function collectToolIds(prompt: readonly unknown[]): ToolIds {
  const called = new Map<string, number>();
  const resulted = new Map<string, number>();
  for (const [i, raw] of prompt.entries()) {
    const content = (raw as PromptMsg).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: string; toolCallId?: string };
      if (p.toolCallId === undefined) continue;
      if (p.type === "tool-call") called.set(p.toolCallId, i);
      else if (p.type === "tool-result") resulted.set(p.toolCallId, i);
    }
  }
  return { called, resulted };
}

/** Empty content, which Anthropic rejects. */
function contentProblems(prompt: readonly unknown[]): string[] {
  const problems: string[] = [];
  for (const [i, raw] of prompt.entries()) {
    const m = raw as PromptMsg;
    if (Array.isArray(m.content)) {
      if (m.content.length === 0) problems.push(`msg[${i}] role=${m.role} empty content array`);
    } else if (typeof m.content === "string" && m.content.length === 0) {
      problems.push(`msg[${i}] role=${m.role} empty string content`);
    }
  }
  return problems;
}

/**
 * Unmatched tool calls and results. Both providers reject these outright —
 * OpenAI with "messages with role 'tool' must be a response to a preceding
 * message with 'tool_calls'", Anthropic with an unexpected-`tool_result` error
 * — so a history carrying one fails every turn until it scrolls out.
 */
function pairingProblems({ called, resulted }: ToolIds): string[] {
  const problems: string[] = [];
  for (const [id, at] of called) {
    const resultAt = resulted.get(id);
    if (resultAt === undefined) problems.push(`dangling tool-call ${id} (msg[${at}])`);
    else if (resultAt < at) problems.push(`tool-result ${id} precedes its call`);
  }
  for (const [id, at] of resulted) {
    if (!called.has(id)) problems.push(`orphan tool-result ${id} (msg[${at}])`);
  }
  return problems;
}

/**
 * Validate one LLM request the way a real provider would, returning every
 * problem found. This is the fuzz's strongest oracle: it turns "would this 400?"
 * into a check that needs no API key.
 */
export function promptProblems(prompt: unknown): string[] {
  if (!Array.isArray(prompt)) return ["prompt is not an array"];
  return [...contentProblems(prompt), ...pairingProblems(collectToolIds(prompt))];
}

/**
 * Report when a provider stream's lifetime ends, for the turn-serialization
 * probe: on abort, or when the stream drains.
 *
 * Both halves are load-bearing and both were wrong in the first draft. An
 * ALREADY-aborted signal never fires `abort`, so a turn aborted before its
 * stream opened would stay counted as live; and an aborted stream's
 * provider-side tail legitimately outlives its turn (the request is cancelled,
 * its bytes just have not stopped arriving), so waiting for the drain alone
 * reports an overlap on every barge-in. Returns the stream branch the caller
 * should hand back to the SDK.
 */
export function trackStreamLifetime<T>(
  stream: ReadableStream<T>,
  signal: AbortSignal | undefined,
  onSettle: () => void,
): ReadableStream<T> {
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    onSettle();
  };
  if (signal?.aborted === true) settle();
  else signal?.addEventListener("abort", settle, { once: true });

  const [forSdk, forProbe] = stream.tee();
  void (async () => {
    const reader = forProbe.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // A cancelled branch is a settled branch.
    } finally {
      settle();
    }
  })();
  return forSdk;
}
