// Copyright 2025 the AAI authors. MIT license.

import type { LanguageModel, UIMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createTestStorage } from "../test-utils.ts";
import { createStudioTools, runStudioChat, type StudioChatDeps } from "./studio-agent.ts";
import type { StudioSandbox } from "./studio-sandbox.ts";
import { getWorkspace, putWorkspace } from "./studio-workspace.ts";

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
  const storage = createTestStorage();
  await putWorkspace(storage, SCOPE, PROJECT, {
    files: { "agent.ts": VALID_AGENT_TS, "notes.md": "hello" },
  });
  const sandboxInstance = fakeSandbox();
  return {
    storage,
    scope: SCOPE,
    project: PROJECT,
    deploy: vi.fn(async () => ({ ok: true as const, slug: "proj", url: "/proj/" })),
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
    const ws = await getWorkspace(deps.storage, SCOPE, PROJECT);
    expect(ws?.files["new.ts"]).toBe("export const x = 1;");
  });

  test("write_file surfaces limit violations as error strings", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    expect(
      await tools.write_file.execute?.({ path: "../evil.ts", content: "x" }, toolOpts()),
    ).toMatch(/^Error:/);
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

  test("deploy_agent reports the live URL on success and the error on failure", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    expect(await tools.deploy_agent.execute?.({}, toolOpts())).toMatch(/live at \/proj\//);

    const failing = await makeDeps({
      deploy: vi.fn(async () => ({ ok: false as const, error: "boom" })),
    });
    expect(await createStudioTools(failing).deploy_agent.execute?.({}, toolOpts())).toBe(
      "Deploy failed: boom",
    );
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
    await putWorkspace(deps.storage, SCOPE, PROJECT, { files: { "agent.ts": "const x = {" } });
    const tools = createStudioTools(deps);
    expect(await tools.test_agent.execute?.({}, toolOpts())).toContain("Build failed");
    expect(deps.sandboxInstance.loadBundle).not.toHaveBeenCalled();
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
