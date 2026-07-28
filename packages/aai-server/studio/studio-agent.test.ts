// Copyright 2025 the AAI authors. MIT license.

import type { LanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createTestStorage } from "../test-utils.ts";
import {
  createStudioTools,
  isStudioLlmConfigured,
  runStudioChat,
  type StudioChatDeps,
  studioModel,
} from "./studio-agent.ts";
import { getWorkspace, putWorkspace } from "./studio-workspace.ts";

const SCOPE = "scope";
const PROJECT = "proj";

async function makeDeps(overrides: Partial<StudioChatDeps> = {}): Promise<StudioChatDeps> {
  const storage = createTestStorage();
  await putWorkspace(storage, SCOPE, PROJECT, {
    files: { "agent.ts": "export default {}", "notes.md": "hello" },
  });
  return {
    storage,
    scope: SCOPE,
    project: PROJECT,
    deploy: vi.fn(async () => ({ ok: true as const, slug: "proj", url: "/proj/" })),
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

async function readEvents(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe("LLM configuration", () => {
  test("isStudioLlmConfigured reflects ANTHROPIC_API_KEY", () => {
    expect(isStudioLlmConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isStudioLlmConfigured({ ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe(true);
  });

  test("studioModel throws when unconfigured and resolves when configured", () => {
    expect(() => studioModel({} as NodeJS.ProcessEnv)).toThrow(/ANTHROPIC_API_KEY/);
    const model = studioModel({
      ANTHROPIC_API_KEY: "k",
      STUDIO_LLM_MODEL: "claude-test-model",
    } as unknown as NodeJS.ProcessEnv);
    expect((model as { modelId: string }).modelId).toBe("claude-test-model");
  });
});

describe("createStudioTools", () => {
  test("list_files lists workspace paths", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    const out = await tools.list_files.execute?.({}, toolOpts());
    expect(out).toBe("agent.ts\nnotes.md");
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
    const out = await tools.write_file.execute?.({ path: "../evil.ts", content: "x" }, toolOpts());
    expect(out).toMatch(/^Error:/);
  });

  test("delete_file removes files and errors on missing ones", async () => {
    const deps = await makeDeps();
    const tools = createStudioTools(deps);
    expect(await tools.delete_file.execute?.({ path: "notes.md" }, toolOpts())).toBe(
      "Deleted notes.md",
    );
    const ws = await getWorkspace(deps.storage, SCOPE, PROJECT);
    expect(ws?.files["notes.md"]).toBeUndefined();
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
    const failingTools = createStudioTools(failing);
    expect(await failingTools.deploy_agent.execute?.({}, toolOpts())).toBe("Deploy failed: boom");
  });

  test("tools error cleanly when the project is missing", async () => {
    const deps = await makeDeps({ project: "ghost" });
    const tools = createStudioTools(deps);
    expect(await tools.list_files.execute?.({}, toolOpts())).toMatch(/not found/);
    expect(await tools.write_file.execute?.({ path: "a.ts", content: "" }, toolOpts())).toMatch(
      /not found/,
    );
  });
});

describe("runStudioChat", () => {
  test("streams text deltas and a done event as NDJSON", async () => {
    const deps = await makeDeps({
      model: fakeModel([
        { type: "text-delta", id: "t1", delta: "Hello " },
        { type: "text-delta", id: "t1", delta: "world" },
      ]),
    });
    const events = await readEvents(runStudioChat(deps, [{ role: "user", content: "hi" }]));
    expect(events).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
      { type: "done" },
    ]);
  });

  test("streams tool calls and write-through tool results", async () => {
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
    const events = await readEvents(
      runStudioChat(deps, [{ role: "user", content: "read my notes" }]),
    );
    expect(events).toContainEqual({
      type: "tool_call",
      name: "read_file",
      input: { path: "notes.md" },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      name: "read_file",
      output: "hello",
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  test("relays model error parts as error events", async () => {
    const deps = await makeDeps({
      model: fakeModel([
        { type: "text-delta", id: "t1", delta: "partial" },
        { type: "error", error: new Error("model exploded") },
      ]),
    });
    const events = await readEvents(runStudioChat(deps, [{ role: "user", content: "hi" }]));
    expect(events).toContainEqual({ type: "text", text: "partial" });
    expect(events).toContainEqual({ type: "error", message: "model exploded" });
  });

  test("emits an error event when the model cannot be created", async () => {
    const deps = await makeDeps(); // no model injected, no ANTHROPIC_API_KEY
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const events = await readEvents(runStudioChat(deps, [{ role: "user", content: "hi" }]));
    expect(events).toEqual([
      { type: "error", message: expect.stringContaining("ANTHROPIC_API_KEY") },
    ]);
  });
});

/** The ai SDK's ToolExecutionOptions arg — tests only need the required fields. */
function toolOpts() {
  return { toolCallId: "call-1", messages: [], context: undefined as never };
}
