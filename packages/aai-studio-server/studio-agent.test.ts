// Copyright 2025 the AAI authors. MIT license.

import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import type { LanguageModel, UIMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createStudioTools, runStudioChat, type StudioChatDeps } from "./studio-agent.ts";
import type { StudioSandbox } from "./studio-sandbox.ts";
import { createWorkspace, getWorkspace, mutateWorkspace } from "./studio-workspace.ts";

const SCOPE = "scope";
const PROJECT = "proj";

const VALID_AGENT_TS = `import { agent } from "@alexkroman1/aai";
export default agent({ name: "Trial Agent" });`;

function fakeSandbox(overrides: Partial<StudioSandbox> = {}): StudioSandbox {
  return {
    loadBundle: vi.fn(async () => ({
      config: {
        name: "Trial Agent",
        systemPrompt: "s",
        toolSchemas: [
          {
            type: "function" as const,
            name: "roll_dice",
            description: "d",
            parameters: { type: "object" },
          },
        ],
        allowedHosts: [],
      },
    })),
    executeTool: vi.fn(async (name: string) => `ran ${name}`),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function makeDeps(
  overrides: Partial<StudioChatDeps> = {},
): Promise<StudioChatDeps & { sandboxInstance: StudioSandbox }> {
  const workspaces = createMemoryWorkspaceStore();
  await createWorkspace(workspaces, SCOPE, PROJECT, {
    files: { "agent.ts": VALID_AGENT_TS, "notes.md": "hello" },
  });
  const sandboxInstance = fakeSandbox();
  return {
    workspaces,
    scope: SCOPE,
    project: PROJECT,
    sandbox: async () => sandboxInstance,
    sandboxInstance,
    ...overrides,
  };
}

// Minimal structural LanguageModel (spec v3) that replays scripted stream
// parts — the same approach as aai's pipeline test fakes.
type ScriptedPart = Record<string, unknown> & { type: string };
function fakeModel(parts: ScriptedPart[]): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-1",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream() {
      const stream = new ReadableStream<ScriptedPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t1" });
          for (const part of parts) controller.enqueue(part);
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            finishReason: "stop",
          });
          controller.close();
        },
      });
      return { stream };
    },
  } as unknown as LanguageModel;
}

function userMessage(text: string): UIMessage {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}

/** Parse the SSE UI message stream into its JSON events. */
async function readSseEvents(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
}

describe("createStudioTools", () => {
  test("list_files lists workspace paths", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    expect(await tools.list_files.execute?.({}, toolOpts())).toBe("agent.ts\nnotes.md");
  });

  test("read_file returns contents and errors on missing files", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    expect(await tools.read_file.execute?.({ path: "notes.md" }, toolOpts())).toBe("hello");
    expect(await tools.read_file.execute?.({ path: "nope.ts" }, toolOpts())).toMatch(
      /no such file/,
    );
  });

  test("write_file persists write-through", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    const out = await tools.write_file.execute?.(
      { path: "new.ts", content: "export const x = 1;" },
      toolOpts(),
    );
    expect(out).toMatch(/Wrote new\.ts/);
    const ws = await getWorkspace(deps.workspaces, SCOPE, PROJECT);
    expect(ws?.files["new.ts"]).toBe("export const x = 1;");
  });

  test("write_file surfaces limit violations as error strings", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    expect(
      await tools.write_file.execute?.({ path: "../evil.ts", content: "x" }, toolOpts()),
    ).toMatch(/^Error:/);
  });

  test("concurrent tool mutations are serialized — neither write is lost", async () => {
    // The AI SDK executes tool calls from one assistant step concurrently;
    // without the workspace lock both reads see the same snapshot and the
    // second put drops the first's file.
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    await Promise.all([
      tools.write_file.execute?.({ path: "a.ts", content: "a" }, toolOpts()),
      tools.write_file.execute?.({ path: "b.ts", content: "b" }, toolOpts()),
    ]);
    const ws = await getWorkspace(deps.workspaces, SCOPE, PROJECT);
    expect(ws?.files["a.ts"]).toBe("a");
    expect(ws?.files["b.ts"]).toBe("b");
  });

  test("delete_file removes files and errors on missing ones", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    expect(await tools.delete_file.execute?.({ path: "notes.md" }, toolOpts())).toBe(
      "Deleted notes.md",
    );
    expect(await tools.delete_file.execute?.({ path: "notes.md" }, toolOpts())).toMatch(
      /no such file/,
    );
  });

  test("exposes no deploy tool — publishing is the user's call", async () => {
    const tools = createStudioTools(await makeDeps());
    expect(Object.keys(tools)).not.toContain("deploy_agent");
    expect(Object.keys(tools).sort()).toEqual([
      "delete_file",
      "edit_file",
      "grep",
      "list_files",
      "read_file",
      "test_agent",
      "todo_write",
      "write_file",
    ]);
  });

  test("edit_file replaceAll rewrites every occurrence", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    const out = await tools.edit_file.execute?.(
      { path: "agent.ts", oldText: "agent", newText: "AGENT", replaceAll: true },
      toolOpts(),
    );
    expect(out).toMatch(/Edited agent\.ts \(\d+ replacements\)/);
    const ws = await getWorkspace(deps.workspaces, SCOPE, PROJECT);
    expect(ws?.files["agent.ts"]).not.toContain("agent(");
    expect(ws?.files["agent.ts"]).toContain("AGENT(");
  });

  test("todo_write echoes the rendered list back as the tool result", async () => {
    const tools = createStudioTools(await makeDeps());
    const out = await tools.todo_write.execute?.(
      {
        todos: [
          { content: "Add add_pizza tool", status: "completed" },
          { content: "Add remove_pizza tool", status: "in_progress" },
          { content: "Run test_agent", status: "pending" },
        ],
      },
      toolOpts(),
    );
    expect(out).toBe(
      "[x] Add add_pizza tool\n[>] Add remove_pizza tool\n[ ] Run test_agent\n\n2 remaining",
    );
  });

  test("file tools share one workspace read per turn", async () => {
    // The per-turn snapshot: read tools cost one store GET total, not one
    // each — the old per-call reads were ~30 round trips on a 16-step turn.
    const deps = await makeDeps();
    const get = vi.spyOn(deps.workspaces, "get");
    const tools = createStudioTools(deps);
    await tools.list_files.execute?.({}, toolOpts());
    await tools.read_file.execute?.({ path: "notes.md" }, toolOpts());
    await tools.grep.execute?.({ pattern: "hello" }, toolOpts());
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("reads after a write see the new content without another store read", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    await tools.write_file.execute?.({ path: "notes.md", content: "updated" }, toolOpts());
    const get = vi.spyOn(deps.workspaces, "get");
    expect(await tools.read_file.execute?.({ path: "notes.md" }, toolOpts())).toBe("updated");
    expect(get).not.toHaveBeenCalled();
  });

  test("tools error cleanly when the project is missing", async () => {
    const deps = await makeDeps({ project: "ghost" });
    const tools = createStudioTools(deps);
    expect(await tools.list_files.execute?.({}, toolOpts())).toMatch(/not found/);
    expect(await tools.test_agent.execute?.({}, toolOpts())).toMatch(/not found/);
  });
});

describe("test_agent tool (sandboxed trial runs)", () => {
  test("builds, loads in the sandbox, and reports the agent summary", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    const out = await tools.test_agent.execute?.({}, toolOpts());
    expect(out).toContain('Agent "Trial Agent"');
    expect(out).toContain("roll_dice");
    expect(deps.sandboxInstance.loadBundle).toHaveBeenCalledTimes(1);
  }, 30_000);

  test("invokes a named agent tool in the sandbox", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    const out = await tools.test_agent.execute?.(
      { tool: "roll_dice", args: { count: 2 } },
      toolOpts(),
    );
    expect(out).toContain("ran roll_dice");
    expect(deps.sandboxInstance.executeTool).toHaveBeenCalledWith("roll_dice", { count: 2 });
  }, 30_000);

  test("refuses to invoke a tool the agent does not define", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    const out = await tools.test_agent.execute?.({ tool: "nope" }, toolOpts());
    expect(out).toContain('Cannot invoke "nope"');
    expect(deps.sandboxInstance.executeTool).not.toHaveBeenCalled();
  }, 30_000);

  test("returns build errors without touching the sandbox", async () => {
    const deps = await makeDeps();
    await mutateWorkspace(deps.workspaces, SCOPE, PROJECT, (ws) => ({
      ...ws,
      files: { "agent.ts": "const x = {" },
    }));
    const tools = createStudioTools(deps);
    expect(await tools.test_agent.execute?.({}, toolOpts())).toContain("Build failed");
    expect(deps.sandboxInstance.loadBundle).not.toHaveBeenCalled();
  }, 30_000);

  test("a sandbox torn down mid tool run yields an error result, not a rejection", async () => {
    // Stream abort disposes the sandbox while the NDJSON round-trip is in
    // flight; the pending RPC rejection must come back as tool-result text.
    const deps = await makeDeps({
      sandbox: async () =>
        fakeSandbox({
          executeTool: vi.fn(async () => {
            throw new Error("Connection disposed");
          }),
        }),
    });
    const out = await createStudioTools(deps).test_agent.execute?.(
      { tool: "roll_dice" },
      toolOpts(),
    );
    expect(out).toContain("Tool run failed: Connection disposed");
  }, 30_000);

  test("reports sandbox load failures and invalid configs", async () => {
    const failing = await makeDeps({
      sandbox: async () =>
        fakeSandbox({
          loadBundle: vi.fn(async () => {
            throw new Error("top-level explosion");
          }),
        }),
    });
    expect(await createStudioTools(failing).test_agent.execute?.({}, toolOpts())).toContain(
      "failed to load",
    );

    const invalid = await makeDeps({
      sandbox: async () => fakeSandbox({ loadBundle: vi.fn(async () => ({ config: 42 })) }),
    });
    expect(await createStudioTools(invalid).test_agent.execute?.({}, toolOpts())).toContain(
      "config is invalid",
    );
  }, 60_000);

  test("logs a load failure host-side, not only into the tool result", async () => {
    // The failure text goes to the model as a tool result, so without this the
    // server's own logs stay empty and a broken sandbox is undebuggable in
    // production — which is exactly how the "Connection disposed" race hid.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = await makeDeps({
      sandbox: async () =>
        fakeSandbox({
          loadBundle: vi.fn(async () => {
            throw new Error("top-level explosion");
          }),
        }),
    });
    await createStudioTools(deps).test_agent.execute?.({}, toolOpts());
    expect(warn).toHaveBeenCalledWith(
      "Studio trial: bundle/load failed",
      expect.objectContaining({ error: "top-level explosion" }),
    );
    warn.mockRestore();
  }, 60_000);
});

describe("runStudioChat", () => {
  test("streams a useChat-compatible SSE UI message stream", async () => {
    const deps = await makeDeps({
      model: fakeModel([
        { type: "text-delta", id: "t1", delta: "Hello " },
        { type: "text-delta", id: "t1", delta: "world" },
      ]),
    });
    const res = await runStudioChat(deps, [userMessage("hi")]);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const events = await readSseEvents(res);
    const types = events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("text-delta");
    expect(types).toContain("finish");
    const textDeltas = events.filter((e) => e.type === "text-delta").map((e) => e.delta);
    expect(textDeltas.join("")).toBe("Hello world");
  });

  test("streams tool input/output events for tool calls", async () => {
    const deps = await makeDeps({
      model: fakeModel([
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read_file",
          input: JSON.stringify({ path: "notes.md" }),
        },
      ]),
    });
    const events = await readSseEvents(await runStudioChat(deps, [userMessage("read notes")]));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-input-available", toolName: "read_file" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-output-available", output: "hello" }),
    );
  });

  test("disposes the session sandbox when the stream finishes", async () => {
    const disposeSandbox = vi.fn(async () => undefined);
    const deps = await makeDeps({
      model: fakeModel([{ type: "text-delta", id: "t1", delta: "done" }]),
      disposeSandbox,
    });
    await readSseEvents(await runStudioChat(deps, [userMessage("hi")]));
    await vi.waitFor(() => {
      expect(disposeSandbox).toHaveBeenCalled();
    });
  });

  test("surfaces model errors as error events and still disposes", async () => {
    const disposeSandbox = vi.fn(async () => undefined);
    const deps = await makeDeps({
      model: fakeModel([{ type: "error", error: new Error("model exploded") }]),
      disposeSandbox,
    });
    const events = await readSseEvents(await runStudioChat(deps, [userMessage("hi")]));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", errorText: "model exploded" }),
    );
    await vi.waitFor(() => {
      expect(disposeSandbox).toHaveBeenCalled();
    });
  });

  test("a tool call that hangs times out into a tool result instead of hanging the turn", async () => {
    // Before the deadline wrapper, a dead sandbox RPC or stalled web fetch
    // left the stream open forever — the client's tool row shimmered with no
    // way out. The turn must finish with an error tool result instead.
    vi.stubEnv("STUDIO_TOOL_TIMEOUT_MS", "50");
    const deps = await makeDeps({
      model: fakeModel([
        { type: "tool-call", toolCallId: "c1", toolName: "test_agent", input: "{}" },
      ]),
      // test_agent builds before it touches the sandbox; a build that never
      // settles is the hang.
      build: () => new Promise(() => undefined),
    });
    // The build cache is content-hash keyed process-wide; a unique file keeps
    // this workspace's hash away from builds cached by earlier tests.
    await mutateWorkspace(deps.workspaces, SCOPE, PROJECT, (ws) => ({
      ...ws,
      files: { ...ws.files, "hang-marker.md": "unique" },
    }));
    const events = await readSseEvents(await runStudioChat(deps, [userMessage("go")]));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-output-available",
        output: expect.stringContaining("test_agent timed out"),
      }),
    );
    expect(events.map((e) => e.type)).toContain("finish");
  });

  test("persists the settled conversation — request messages plus the reply", async () => {
    const persistMessages = vi.fn(async (_messages: UIMessage[]): Promise<void> => undefined);
    const deps = await makeDeps({
      model: fakeModel([
        { type: "text-delta", id: "t1", delta: "Hello " },
        { type: "text-delta", id: "t1", delta: "world" },
      ]),
      persistMessages,
    });
    await readSseEvents(await runStudioChat(deps, [userMessage("hi")]));
    await vi.waitFor(() => {
      expect(persistMessages).toHaveBeenCalledTimes(1);
    });
    const [updated] = persistMessages.mock.calls[0] as [UIMessage[]];
    // The full conversation: the original user message followed by the
    // assistant response the stream produced.
    expect(updated[0]).toMatchObject({ id: "m1", role: "user" });
    const reply = updated.at(-1);
    expect(reply?.role).toBe("assistant");
    const text = reply?.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toBe("Hello world");
  });

  test("a failed persist is logged, never fatal to the stream", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = await makeDeps({
      model: fakeModel([{ type: "text-delta", id: "t1", delta: "ok" }]),
      persistMessages: vi.fn(async () => {
        throw new Error("chat row unavailable");
      }),
    });
    const events = await readSseEvents(await runStudioChat(deps, [userMessage("hi")]));
    expect(events.map((e) => e.type)).toContain("finish");
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "Studio chat: failed to persist conversation",
        expect.objectContaining({ error: "chat row unavailable" }),
      );
    });
    warn.mockRestore();
  });

  test("rejects when the model cannot be created (and disposes)", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("STUDIO_LLM_PROVIDER", "");
    const disposeSandbox = vi.fn(async () => undefined);
    const deps = await makeDeps({ disposeSandbox });
    await expect(runStudioChat(deps, [userMessage("hi")])).rejects.toThrow(/not configured/);
    expect(disposeSandbox).toHaveBeenCalled();
  });
});

/** The ai SDK's ToolExecutionOptions arg — tests only need the required fields. */
function toolOpts() {
  return { toolCallId: "call-1", messages: [], context: undefined as never };
}
