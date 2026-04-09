// Copyright 2025 the AAI authors. MIT license.
/**
 * Type-level tests for the public API surface of @alexkroman1/aai.
 *
 * These are checked by tsc (via vitest typecheck) but never executed.
 * A failure here means a public type contract has regressed.
 */

import { describe, expectTypeOf, it } from "vitest";
import { createRuntime, type Runtime } from "./host/runtime.ts";
import {
  type BuiltinTool,
  type HookFlags,
  type Manifest,
  type Message,
  parseManifest,
  type ToolManifest,
  type ToolResultMap,
} from "./index.ts";
// Internal import — createRuntime still uses AgentDef internally.
import { defineAgent } from "./isolate/types.ts";

// ─── parseManifest ───────────────────────────────────────────────────────

describe("parseManifest", () => {
  it("accepts valid input and returns Manifest", () => {
    const manifest = parseManifest({ name: "test" });
    expectTypeOf(manifest).toEqualTypeOf<Manifest>();
  });

  it("returns an object with expected fields", () => {
    const manifest = parseManifest({ name: "test" });
    expectTypeOf(manifest.name).toBeString();
    expectTypeOf(manifest.systemPrompt).toBeString();
    expectTypeOf(manifest.greeting).toBeString();
    expectTypeOf(manifest.builtinTools).toEqualTypeOf<string[]>();
    expectTypeOf(manifest.maxSteps).toBeNumber();
    expectTypeOf(manifest.toolChoice).toEqualTypeOf<"auto" | "required">();
    expectTypeOf(manifest.tools).toEqualTypeOf<Record<string, ToolManifest>>();
    expectTypeOf(manifest.hooks).toEqualTypeOf<HookFlags>();
  });
});

// ─── Manifest types ──────────────────────────────────────────────────────

describe("Manifest", () => {
  it("has expected shape", () => {
    expectTypeOf<Manifest>().toHaveProperty("name");
    expectTypeOf<Manifest>().toHaveProperty("systemPrompt");
    expectTypeOf<Manifest>().toHaveProperty("greeting");
    expectTypeOf<Manifest>().toHaveProperty("builtinTools");
    expectTypeOf<Manifest>().toHaveProperty("maxSteps");
    expectTypeOf<Manifest>().toHaveProperty("toolChoice");
    expectTypeOf<Manifest>().toHaveProperty("tools");
    expectTypeOf<Manifest>().toHaveProperty("hooks");
  });
});

describe("ToolManifest", () => {
  it("has description and optional parameters", () => {
    expectTypeOf<ToolManifest>().toHaveProperty("description");
    expectTypeOf<ToolManifest["description"]>().toBeString();
    expectTypeOf<ToolManifest["parameters"]>().toEqualTypeOf<Record<string, unknown> | undefined>();
  });
});

describe("HookFlags", () => {
  it("has boolean flags for each hook", () => {
    expectTypeOf<HookFlags["onConnect"]>().toBeBoolean();
    expectTypeOf<HookFlags["onDisconnect"]>().toBeBoolean();
    expectTypeOf<HookFlags["onUserTranscript"]>().toBeBoolean();
    expectTypeOf<HookFlags["onError"]>().toBeBoolean();
  });
});

// ─── createRuntime (internal — used by aai-cli and aai-server) ──────────

describe("createRuntime", () => {
  it("accepts RuntimeOptions and returns Runtime", () => {
    const agent = defineAgent({ name: "test" });
    const runtime = createRuntime({ agent, env: {} });
    expectTypeOf(runtime).toMatchTypeOf<Runtime>();
    expectTypeOf(runtime.startSession).toBeFunction();
    expectTypeOf(runtime.shutdown).toEqualTypeOf<() => Promise<void>>();
  });
});

// ─── Key types exist and have expected shapes ────────────────────────────

describe("exported types", () => {
  it("Message has expected shape", () => {
    expectTypeOf<Message>().toEqualTypeOf<{
      role: "user" | "assistant" | "tool";
      content: string;
    }>();
  });

  it("BuiltinTool is a union of known tool names", () => {
    expectTypeOf<BuiltinTool>().toEqualTypeOf<
      "web_search" | "visit_webpage" | "fetch_json" | "run_code"
    >();
  });

  it("ToolResultMap passes through its generic", () => {
    type MyResults = ToolResultMap<{ add: { id: number }; remove: { ok: boolean } }>;
    expectTypeOf<MyResults>().toEqualTypeOf<{ add: { id: number }; remove: { ok: boolean } }>();
  });
});
