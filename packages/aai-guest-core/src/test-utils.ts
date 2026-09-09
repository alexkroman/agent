// Copyright 2026 the AAI authors. MIT license.
/**
 * Guest test helpers every guest package needs.
 *
 * NOT `_`-prefixed, and that is the whole reason this module exists rather
 * than a copy per package: `_*.ts` is package-private (Biome's
 * `noPrivateImports`), so a shared helper has to be a real subpath export.
 * `aai-server/src/test-utils.ts` is the same shape for the same reason.
 *
 * What stays behind is what cannot come here. `npmResult` fixtures a
 * `runNpm` result and that function is `aai-guest-studio`'s, so importing it
 * would point core at a package that depends on core; `stubProcessExit` is
 * the harness entry's, and only its crash-guard specs reach for it. Each
 * lives in its own package's `_test-utils.ts`.
 *
 * The `vi.mock` factories that install the spawn mocks stay per-file — they
 * are hoisted, so they cannot be shared.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDef } from "@alexkroman1/aai";
import { WS_OPEN } from "@alexkroman1/aai/internal";
import type { SessionWebSocket } from "@alexkroman1/aai-runtime";
import { executeToolCall } from "@alexkroman1/aai-runtime/internal";
import { afterEach, beforeEach } from "vitest";
import { emptyHarnessState, type HarnessState } from "./bundle.ts";
import { handleHostResponse, setHostSend } from "./rpc.ts";
import type { AgentDef, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./types.ts";
/**
 * Run one coding-agent tool the way a turn does.
 *
 * The guest's tools are SDK {@link ToolDef}s now, so a spec must not call
 * `execute` directly: the observable behaviour of a tool call includes
 * argument validation, the per-call `ctx`, the deadline, and the conversion
 * of a THROW into an error string the model can read — all of which live in
 * `executeToolCall`, which is what `createTextAgent` dispatches through. A
 * spec that reached past it would be asserting against a path production does
 * not take (and several here depend on exactly that shaping: a path escape is
 * a throw, and it must arrive as text).
 */
export async function runTool(
  tools: Record<string, ToolDef>,
  name: string,
  args: Record<string, unknown> = {},
  overrides: Partial<Parameters<typeof executeToolCall>[2]> = {},
): Promise<string> {
  const tool = tools[name];
  if (!tool) throw new Error(`no such tool: ${name}`);
  return await executeToolCall(name, args, {
    tool,
    env: {},
    sessionId: "test-session",
    ...overrides,
  });
}

/**
 * A temp workspace directory that removes itself after every test.
 *
 * Call it at module or `describe` scope; it registers its own hooks, which is
 * the whole point. Six suites open-coded `mkdtemp` + `rm` in three styles and
 * one of them leaked: `studio/project-shape.test.ts` shared a single `let dir`
 * across two `describe` blocks, so the second block's `afterEach` re-`rm`'d a
 * path the first had already deleted while its own directories were never
 * removed at all. Creating the directory and registering its cleanup in one
 * place makes that unrepresentable.
 */
export function useTempDir(prefix: string): () => string {
  const make = useTempDirs(prefix);
  let dir: string | null = null;
  beforeEach(async () => {
    dir = await make();
  });
  afterEach(() => {
    dir = null;
  });
  return () => {
    if (dir === null) throw new Error(`useTempDir(${prefix}): read outside a test`);
    return dir;
  };
}

/**
 * The same thing for a suite that needs SEVERAL directories per test — a
 * workspace plus a fake toolchain, or one per case. `useTempDir` is this with
 * one call made for you in a `beforeEach`.
 */
export function useTempDirs(prefix: string): () => Promise<string> {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}

/** Write a files record into `dir`, as the studio build helpers' callers do. */
export async function materialize(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(dir, rel), content, "utf-8");
  }
}

/**
 * The fake host control channel, installed on the module-level `setHostSend`
 * singleton. The caller owns teardown (`setHostSend(null)` plus, where a
 * request may still be pending, `rejectAllPendingHostRequests`) because the
 * singleton is process-scoped and each suite installs it at a different point.
 *
 * Written out three times before this — twice verbatim — and every reader then
 * re-narrowed `sent.at(-1)` to its own ad-hoc shape. The frames are JSON-RPC,
 * so {@link FakeHostChannel.lastRequest} / {@link FakeHostChannel.lastResponse}
 * narrow them ONCE, by runtime check rather than by cast: a spec that asks for
 * the wrong half of the union fails naming what actually arrived instead of
 * reading `undefined` off a lie.
 */
export type FakeHostChannel = {
  /** Every frame the guest wrote to the host socket, in order. */
  readonly sent: JsonRpcMessage[];
  /** The last frame, asserted to be a guest→host REQUEST. */
  lastRequest(): JsonRpcRequest;
  /** The last frame, asserted to be a RESPONSE to a host→guest request. */
  lastResponse(): JsonRpcResponse;
  /** Answer the most recent outbound host request. */
  answerLast(result?: unknown, error?: { code: number; message: string }): void;
};

function lastFrame(sent: readonly JsonRpcMessage[]): JsonRpcMessage {
  const frame = sent.at(-1);
  if (!frame) throw new Error("no frame was sent to the host channel");
  return frame;
}

export function installFakeHostChannel(options: { autoAnswer?: boolean } = {}): FakeHostChannel {
  const sent: JsonRpcMessage[] = [];
  const channel: FakeHostChannel = {
    sent,
    lastRequest() {
      const frame = lastFrame(sent);
      if (!("method" in frame && "id" in frame)) {
        throw new Error(`last frame is not a request: ${JSON.stringify(frame)}`);
      }
      return frame;
    },
    lastResponse() {
      const frame = lastFrame(sent);
      if ("method" in frame || !("id" in frame)) {
        throw new Error(`last frame is not a response: ${JSON.stringify(frame)}`);
      }
      return frame;
    },
    answerLast(result?: unknown, error?: { code: number; message: string }) {
      const { id } = channel.lastRequest();
      // The two branches are the JSON-RPC response's two SHAPES, so choosing the
      // whole object states that; a spread of one key or the other reads as an
      // optional field on one shape, which is not what a response is.
      handleHostResponse(error ? { id, error } : { id, result });
    },
  };
  setHostSend((msg) => {
    sent.push(msg);
    // The studio suites need the guest's own RPCs to SETTLE — a sync or a
    // persist that never resolves leaves a turn half-finished at teardown.
    if (options.autoAnswer && "method" in msg && "id" in msg) {
      queueMicrotask(() => handleHostResponse({ id: msg.id, result: {} }));
    }
  });
  return channel;
}

/**
 * An `AgentDef` with three tools that between them cover the outcomes a tool
 * call has: a plain return, a mutation of `ctx.state`, and a throw.
 *
 * Here rather than beside the harness entry's spec because it fixtures core's
 * OWN type, and three packages' suites build one.
 */
export function makeAgent(overrides?: Partial<AgentDef>): AgentDef {
  return {
    name: "t",
    systemPrompt: "p",
    greeting: "g",
    tools: {
      echo: {
        description: "echo",
        execute: (args) => `echo:${(args as { text: string }).text}`,
      },
      mutate: {
        description: "bump ctx.state.count",
        execute: (_args, ctx) => {
          const state = ctx.state as { count?: number };
          state.count = (state.count ?? 0) + 1;
          return `count=${state.count}`;
        },
      },
      explode: {
        description: "always throws",
        execute: () => {
          throw new Error("kaboom");
        },
      },
    },
    ...overrides,
  };
}

export function makeState(overrides?: Partial<HarnessState>): HarnessState {
  return { ...emptyHarnessState(), ...overrides };
}

/** The factory export every real bundle carries; the fixture is inert. */
export const FAKE_RUNTIME_EXPORT = `export const __aaiCreateRuntime = () =>
  ({ startSession: () => undefined, shutdown: () => Promise.resolve() });`;

/** A one-shot trial's options: no env at all. */
export const TRIAL_OPTS = { env: Object.freeze({}) };

/**
 * The one event shape {@link fakeSocket} replays. An INTERSECTION of what
 * `SessionWebSocket`'s four `addEventListener` overloads hand their listeners,
 * which is what lets one implementation satisfy all four — a per-overload
 * implementation signature needs an `any` (see `_mock-ws.ts`), and narrowing
 * the socket at the call site is the `as never` this replaced.
 */
type FrameEvent = { code?: number; reason?: string } & { data: unknown } & { message?: string };

/**
 * A fake session socket: records closes, replays close events.
 *
 * Structurally a {@link SessionWebSocket}, so the `startSession` calls below
 * need no cast — which is also the assertion that `lazyRuntime` touches only
 * the socket contract the runtime really promises it.
 */
export function fakeSocket(): SessionWebSocket & {
  closes: { code: number; reason: string }[];
  emit(type: string): void;
} {
  const listeners = new Map<string, (event: FrameEvent) => void>();
  const closes: { code: number; reason: string }[] = [];
  const addEventListener: SessionWebSocket["addEventListener"] = (
    type: string,
    listener: (event: FrameEvent) => void,
  ) => {
    listeners.set(type, listener);
  };
  return {
    readyState: WS_OPEN,
    closes,
    close(code?: number, reason?: string) {
      closes.push({ code: code ?? 0, reason: reason ?? "" });
    },
    send() {
      // Nothing here reads what a session sends; the socket is a close recorder.
    },
    addEventListener,
    emit(type: string) {
      listeners.get(type)?.({ code: 1000, reason: "", data: null, message: "" });
    },
  };
}
