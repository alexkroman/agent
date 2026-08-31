// Copyright 2026 the AAI authors. MIT license.
/**
 * The STUDIO target: one starter prompt, one coding-agent turn, one workspace.
 *
 * This is the machinery that used to be `scripts/starter-eval/run.mjs` — a
 * second, non-vitest test runner with its own case loop, verdict aggregation and
 * reporter. Its ASSERTIONS were and are a different job from behaviour (they
 * grade generated SOURCE, and live in `./starter-expectations.ts`); what is here
 * is only the driving of the studio's real HTTP surface, which the eval tier now
 * owns for both targets.
 *
 * It drives create-project → broker a sandbox session → stream one chat turn, so
 * it exercises the same server and guest path a browser does.
 *
 * @module
 */

import { sleep } from "@alexkroman1/aai/internal";
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
import {
  getToolName,
  isDynamicToolUIPart,
  isToolUIPart,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { EventSourceMessage } from "eventsource-parser";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * A turn can legitimately run for many minutes (the studio's step cap is 80),
 * and undici's default 300s body timeout kills the SSE stream mid-run — which
 * surfaces as `TypeError: terminated` and reads exactly like the guest crashing.
 * It is the CLIENT giving up, so the client is what gets the longer leash; the
 * turn's real bound is {@link TURN_TIMEOUT_MS}.
 */
const streamDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

/**
 * Above the guest's own `HARD_TURN_MS` (12 min), so the SERVER decides when a
 * turn ends rather than the measuring client — an aborted stream reads as a
 * crash and loses the run.
 */
const TURN_TIMEOUT_MS = 20 * 60_000;

/** How long the post-turn workspace sync is waited out. */
const WORKSPACE_TIMEOUT_MS = 20_000;
const WORKSPACE_POLL_MS = 500;

/** How much of a red verification's output to keep. */
const MAX_RED_EXCERPT = 600;

/**
 * `formatPostWriteDiagnostics` (aai-guest/studio-write-diagnostics.ts) prefixes
 * every red write result with a fixed ~165-character instruction, so an excerpt
 * taken before stripping it is boilerplate plus one truncated error — cutting
 * exactly the diagnostic the excerpt exists to preserve.
 */
const WRITE_DIAGNOSTIC_PREAMBLE = /^[\s\S]*?Type errors after writing (\S+)[^:]*:\s*/;

/**
 * `test_agent` leads with its SUCCESS prose, and the tool list in it grows with
 * the agent — on a tool-rich agent that preamble alone ate the whole excerpt, so
 * a failed run recorded eight tool names and "Tests: FAILED" and not one line of
 * why.
 */
const TEST_AGENT_PREAMBLE =
  /^\s*Bundle loaded[^.]*\.\s*Agent "[^"]*" \([a-z0-9]+ mode\)[^\n.]*\.\s*/i;

/**
 * The tools whose output carries a TypeScript verification.
 *
 * A SET rather than a chain of `===`, and it covers more than `test_agent`
 * deliberately: counting only the test tool makes the metric movable by
 * REORDERING tools, since an agent whose cheaper checks catch the errors first
 * scores zero repairs while having written exactly the same wrong code.
 */
const VERIFYING_TOOLS: ReadonlySet<string> = new Set([
  "test_agent",
  "check_types",
  "write_file",
  "edit_file",
]);

/** One line of at most {@link MAX_RED_EXCERPT} characters — both readers end here. */
function condense(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_RED_EXCERPT);
}

/** One red verification, reduced to the diagnostics themselves. */
function redExcerpt(name: string, out: string): string {
  const body = out.replace(WRITE_DIAGNOSTIC_PREAMBLE, (_m, file: string) => `${file}: `);
  return `${name}: ${condense(body)}`;
}

/** One failed `test_agent` run, reduced to what actually failed. */
function failureExcerpt(out: string): string {
  return condense(out.replace(TEST_AGENT_PREAMBLE, ""));
}

/** What one streamed turn produced. */
export type StudioTurn = {
  /** Tool names in call order. */
  readonly toolCalls: readonly string[];
  /** Every `test_agent` run and whether it came back green. */
  readonly testAgentRuns: readonly {
    readonly buildFailed: boolean;
    readonly testsFailed: boolean;
    readonly excerpt: string;
  }[];
  /** Tool names whose result carried a TypeScript error, in order. */
  readonly redChecks: readonly string[];
  readonly redExcerpts: readonly string[];
  /** The last `test_agent` output, which is where the loaded config is read. */
  readonly lastTestAgentOutput: string;
  readonly text: string;
  readonly errors: readonly string[];
  readonly ms: number;
};

type MutableTurn = {
  -readonly [K in keyof StudioTurn]: StudioTurn[K] extends readonly (infer T)[]
    ? T[]
    : StudioTurn[K];
};

/** Fold one `tool-output-available` result into the turn. */
function recordToolOutput(turn: MutableTurn, name: string | undefined, out: string): void {
  if (name === "test_agent") {
    turn.testAgentRuns.push({
      buildFailed: /error TS\d|Type check failed|Build failed|failed to load/i.test(out),
      testsFailed: /Tests: FAILED/i.test(out),
      excerpt: failureExcerpt(out),
    });
    turn.lastTestAgentOutput = out;
  }
  // Any verification that came back red, whichever tool ran it — see
  // {@link VERIFYING_TOOLS}.
  if (name !== undefined && VERIFYING_TOOLS.has(name) && /error TS\d/i.test(out)) {
    turn.redChecks.push(name);
    turn.redExcerpts.push(redExcerpt(name, out));
  }
}

/**
 * The response body as the chunk stream {@link readUIMessageStream} wants.
 *
 * `EventSourceParserStream` is the framing the AI SDK's own transport uses, and
 * it handles what a split-on-newline loop gets subtly wrong: `\r\n` and lone-`\r`
 * delimiters, multi-line `data:` fields, keep-alive comments, a BOM, and a field
 * value with no space after the colon.
 *
 * A non-JSON frame is SKIPPED rather than thrown on: one malformed message is
 * not worth losing a turn that may already have run for minutes. `safeJsonParse`
 * rather than a `try`/`catch` around `JSON.parse` — an unparsable frame becomes
 * `undefined`, which the `isRecord` guard drops, without a catch block wide
 * enough to also swallow a real fault downstream.
 *
 * The cast is where an untyped wire meets a typed reader, and it is exactly as
 * permissive as the hand-rolled fold it replaces: `processUIMessageStream`
 * switches on `chunk.type` with a `default` that ignores what it does not
 * recognise, so a chunk kind this SDK version has never heard of is dropped
 * there rather than being mis-read here.
 */
function chunkStream(body: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
  const decoder = new TextDecoder();
  return body
    .pipeThrough(
      // Hand-written rather than `TextDecoderStream`, whose `writable` is typed
      // `WritableStream<BufferSource>` — a name this package's node-only lib set
      // does not carry, so `pipeThrough` from a `ReadableStream<Uint8Array>`
      // will not accept it. `{ stream: true }` is the load-bearing part either
      // way: it holds back a multi-byte character split across two chunks.
      new TransformStream<Uint8Array, string>({
        transform(bytes, controller) {
          controller.enqueue(decoder.decode(bytes, { stream: true }));
        },
        flush(controller) {
          controller.enqueue(decoder.decode());
        },
      }),
    )
    .pipeThrough(new EventSourceParserStream())
    .pipeThrough(
      new TransformStream<EventSourceMessage, UIMessageChunk>({
        transform(event, controller) {
          if (event.data === "" || event.data === "[DONE]") return;
          const parsed = safeJsonParse(event.data);
          if (isRecord(parsed)) controller.enqueue(parsed as UIMessageChunk);
        },
      }),
    );
}

/**
 * Fold the FINAL message snapshot into the turn.
 *
 * {@link readUIMessageStream} accumulates the chunk stream into successive
 * snapshots of one `UIMessage`, so the last one carries every part in call order
 * — and the SDK has already done the `toolCallId` → tool-name correlation this
 * file used to keep in a `Map`. That map was the bookkeeping most likely to rot
 * when the wire format moves, and the string-prefix tests around it
 * (`type.startsWith("tool-output-available")`) encoded a part-naming scheme that
 * is the SDK's to change. What is left here is only the grading-specific read.
 */
function foldMessage(turn: MutableTurn, message: UIMessage | undefined): void {
  for (const part of message?.parts ?? []) {
    if (part.type === "text") {
      turn.text += part.text;
      continue;
    }
    if (!(isToolUIPart(part) || isDynamicToolUIPart(part))) continue;
    // A call still streaming its input has not been MADE yet; every later state
    // means the model committed to it, which is what the `tool-input-available`
    // frame marked when this was read chunk by chunk.
    if (part.state === "input-streaming") continue;
    const name = getToolName(part);
    turn.toolCalls.push(name);
    if (part.state !== "output-available") continue;
    const out = typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? "");
    recordToolOutput(turn, name, out);
  }
}

/**
 * Read one chat turn off a response body.
 *
 * Exported as a SEAM, and it is the only part of this file a unit test can
 * reach: everything around it needs a live studio, a real sandbox and a model,
 * which is why this module is excluded from the package's coverage floors. The
 * stream reading is also the half most likely to break silently — a part-shape
 * the SDK renamed folds to an empty turn, and an empty turn grades as a coding
 * agent that did nothing rather than as a broken harness. `studio-target.test.ts`
 * drives it with canned SSE for exactly that reason.
 */
export async function readTurn(body: ReadableStream<Uint8Array>): Promise<StudioTurn> {
  const started = Date.now();
  const turn: MutableTurn = {
    toolCalls: [],
    testAgentRuns: [],
    redChecks: [],
    redExcerpts: [],
    lastTestAgentOutput: "",
    text: "",
    errors: [],
    ms: 0,
  };
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({
    stream: chunkStream(body),
    // Errors are RECORDED and the turn runs on. This is also the option's
    // default, stated rather than relied on: a turn cut short at its first
    // error loses every tool call after it, and a partial transcript grades as
    // an agent that stopped working.
    terminateOnError: false,
    onError: (error) => {
      // `processUIMessageStream` wraps an `error` chunk as `new
      // Error(errorText)`, so the message is the wire's own text.
      turn.errors.push(error instanceof Error ? error.message : String(error));
    },
  })) {
    last = message;
  }
  foldMessage(turn, last);
  turn.ms = Date.now() - started;
  return turn;
}

/** One studio project, from creation to a synced workspace. */
export type StudioClient = {
  /** `POST /studio/projects` + `POST …/session`, then stream one chat turn. */
  runTurn(project: string, kind: string, prompt: string): Promise<StudioTurn>;
  /** The project's files once the guest's end-of-turn sync has landed. */
  workspace(project: string): Promise<Record<string, string> | undefined>;
  /**
   * `DELETE /studio/projects/:project` — remove what the case created.
   *
   * A case that leaves its project behind leaves DURABLE platform state: this
   * target drives a real studio, so on a dev server against the local Supabase
   * stack the row, its workspace and its `*-preview` agent all survive the run
   * and every run after it. The visible cost is a projects sidebar of dead
   * `eval-*` entries; the real one is that the dev server keeps trying to boot
   * their preview agents, so every one is a recurring 503 in the log that names
   * no test — the same reason the store-conformance cases remove their own rows.
   *
   * Best-effort by contract: a delete that fails must not fail the CASE, whose
   * verdict is about generated source and was already decided.
   */
  deleteProject(project: string): Promise<void>;
};

/** A studio client against `origin`, authenticated with `key`. */
export function createStudioClient(origin: string, key: string): StudioClient {
  const api = async (endpoint: string, init: RequestInit = {}): Promise<unknown> => {
    const res = await fetch(`${origin}/studio${endpoint}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };

  const streamTurn = async (
    url: string,
    sandboxToken: string,
    prompt: string,
  ): Promise<StudioTurn> => {
    const res = await undiciFetch(url, {
      method: "POST",
      headers: {
        // The PER-SANDBOX token from the session broker, not the account's API
        // key: the chat endpoint belongs to the guest, which is authenticated by
        // the token minted at spawn. `run.mjs` sent the API key here and got
        // `401 Unauthorized`, so the harness this replaces could not have run —
        // one more reason a second runner nobody exercises is worth deleting.
        Authorization: `Bearer ${sandboxToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: prompt }] }],
      }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      dispatcher: streamDispatcher,
    });
    if (!(res.ok && res.body)) {
      throw new Error(`chat -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return readTurn(res.body);
  };

  return {
    async runTurn(project, kind, prompt) {
      // `kind` mirrors the studio hero's switcher: the project is created the
      // way a user picking THIS starter would create it, so the turn runs under
      // the same coding-agent system prompt.
      await api("/projects", { method: "POST", body: JSON.stringify({ name: project, kind }) });
      const session = (await api(`/projects/${project}/session`, {
        method: "POST",
        body: "{}",
      })) as { url?: unknown; token?: unknown };
      if (typeof session.url !== "string" || typeof session.token !== "string") {
        throw new Error("studio session returned no url/token");
      }
      return streamTurn(session.url, session.token, prompt);
    },

    async deleteProject(project) {
      // Best-effort, per the contract above: the case's verdict is already
      // decided, and a cleanup that throws would turn a passing eval red.
      await api(`/projects/${project}`, { method: "DELETE" }).catch(() => undefined);
    },

    async workspace(project) {
      // POLL, do not read once. The guest syncs the workspace back to the host
      // in its onFinish handler, which can land after the stream closes — a
      // single read races it and returns an empty project, i.e. a capability
      // check that fails everything.
      const deadline = Date.now() + WORKSPACE_TIMEOUT_MS;
      for (;;) {
        const read = (await api(`/projects/${project}`).catch(() => undefined)) as
          | { files?: Record<string, string> }
          | undefined;
        const files = read?.files;
        // agent.ts is the file every starter must produce; its presence means
        // the sync has happened rather than merely that the project exists. Out
        // of time, the last read is what there is to report.
        if (files?.["agent.ts"] !== undefined || Date.now() >= deadline) return files;
        await sleep(WORKSPACE_POLL_MS);
      }
    },
  };
}
