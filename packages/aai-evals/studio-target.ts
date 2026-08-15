// Copyright 2026 the AAI authors. MIT license.
/**
 * The STUDIO target: one starter prompt, one coding-agent turn, one workspace.
 *
 * This is the machinery that used to be `scripts/starter-eval/run.mjs` — a
 * second, non-vitest test runner with its own case loop, verdict aggregation and
 * reporter. Its ASSERTIONS were and are a different job from behaviour (they
 * grade generated SOURCE, and still live in
 * `scripts/starter-eval/expectations.mjs`); what is here is only the driving of
 * the studio's real HTTP surface, which the eval tier now owns for both targets.
 *
 * It drives create-project → broker a sandbox session → stream one chat turn, so
 * it exercises the same server and guest path a browser does.
 *
 * @module
 */

import { sleep } from "@alexkroman1/aai/internal";
import { isRecord } from "@alexkroman1/aai/utils";
import { createParser } from "eventsource-parser";
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

/** One red verification, reduced to the diagnostics themselves. */
function redExcerpt(name: string, out: string): string {
  const body = out.replace(WRITE_DIAGNOSTIC_PREAMBLE, (_m, file: string) => `${file}: `);
  return `${name}: ${body.replace(/\s+/g, " ").trim().slice(0, MAX_RED_EXCERPT)}`;
}

/** One failed `test_agent` run, reduced to what actually failed. */
function failureExcerpt(out: string): string {
  return out.replace(TEST_AGENT_PREAMBLE, "").replace(/\s+/g, " ").trim().slice(0, MAX_RED_EXCERPT);
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
  // Any verification that came back red, whichever tool ran it. Counting only
  // test_agent makes the metric movable by REORDERING tools: an agent whose
  // cheaper checks catch the errors first scores zero repairs while having
  // written exactly the same wrong code.
  const verifies =
    name === "test_agent" ||
    name === "check_types" ||
    name === "write_file" ||
    name === "edit_file";
  if (verifies && /error TS\d/i.test(out)) {
    turn.redChecks.push(name);
    turn.redExcerpts.push(redExcerpt(name, out));
  }
}

/** Fold one AI SDK UI-message-stream part into the turn. */
function applyPart(turn: MutableTurn, pending: Map<string, string>, part: unknown): void {
  if (!isRecord(part)) return;
  const p = part;
  const type = typeof p.type === "string" ? p.type : "";
  if (type === "text-delta" && typeof p.delta === "string") {
    turn.text += p.delta;
    return;
  }
  const callId = typeof p.toolCallId === "string" ? p.toolCallId : "";
  if (type.startsWith("tool-input-available") && typeof p.toolName === "string") {
    pending.set(callId, p.toolName);
    turn.toolCalls.push(p.toolName);
    return;
  }
  if (type.startsWith("tool-output-available")) {
    const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
    recordToolOutput(turn, pending.get(callId), out);
    return;
  }
  if (type === "error") turn.errors.push(String(p.errorText ?? "error"));
}

/** One studio project, from creation to a synced workspace. */
export type StudioClient = {
  /** `POST /studio/projects` + `POST …/session`, then stream one chat turn. */
  runTurn(project: string, kind: string, prompt: string): Promise<StudioTurn>;
  /** The project's files once the guest's end-of-turn sync has landed. */
  workspace(project: string): Promise<Record<string, string> | undefined>;
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
    const started = Date.now();
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
    const pending = new Map<string, string>();
    // Framing is `eventsource-parser`'s job: it handles the parts a
    // split-on-newline loop gets subtly wrong — `\r\n` and lone-`\r`
    // delimiters, multi-line `data:` fields, keep-alive comments, a BOM, and a
    // field value with no space after the colon. A non-JSON frame is SKIPPED
    // rather than thrown on: one malformed message is not worth losing a turn
    // that may already have run for minutes.
    const parser = createParser({
      onEvent(event) {
        if (event.data === "" || event.data === "[DONE]") return;
        try {
          applyPart(turn, pending, JSON.parse(event.data));
        } catch {
          // Unparsable frame; see above.
        }
      },
    });
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      parser.feed(decoder.decode(chunk as Uint8Array, { stream: true }));
    }
    turn.ms = Date.now() - started;
    return turn;
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

    async workspace(project) {
      // POLL, do not read once. The guest syncs the workspace back to the host
      // in its onFinish handler, which can land after the stream closes — a
      // single read races it and returns an empty project, i.e. a capability
      // check that fails everything.
      const deadline = Date.now() + WORKSPACE_TIMEOUT_MS;
      let files: Record<string, string> | undefined;
      for (;;) {
        const project_ = (await api(`/projects/${project}`).catch(() => undefined)) as
          | { files?: Record<string, string> }
          | undefined;
        files = project_?.files;
        // agent.ts is the file every starter must produce; its presence means
        // the sync has happened rather than merely that the project exists.
        if (files?.["agent.ts"] !== undefined) return files;
        if (Date.now() >= deadline) return files;
        await sleep(WORKSPACE_POLL_MS);
      }
    },
  };
}
