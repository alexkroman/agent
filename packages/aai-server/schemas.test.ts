// Copyright 2025 the AAI authors. MIT license.
import {
  ClientMessageSchema,
  ReadyConfigSchema,
  ServerMessageSchema,
} from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import { MAX_WORKER_SIZE } from "./constants.ts";
import { IsolateConfigSchema } from "./rpc-schemas.ts";
import {
  DeployBodySchema,
  EnvSchema,
  RESERVED_SLUGS,
  SafePathSchema,
  SecretUpdatesSchema,
} from "./schemas.ts";
import { TEST_AGENT_CONFIG } from "./test-utils.ts";

// ── DeployBodySchema ───────────────────────────────────────────────────

describe("DeployBodySchema", () => {
  test.each([
    [
      "valid deploy body",
      {
        worker: "console.log('hello');",
        clientFiles: { "index.html": "<html></html>" },
        agentConfig: TEST_AGENT_CONFIG,
      },
      true,
    ],
    [
      "deploy body with env",
      {
        env: { MY_SECRET: "value" },
        worker: "console.log('hello');",
        clientFiles: {},
        agentConfig: TEST_AGENT_CONFIG,
      },
      true,
    ],
    ["missing worker field", { clientFiles: {}, agentConfig: TEST_AGENT_CONFIG }, false],
    ["empty worker string", { worker: "", clientFiles: {}, agentConfig: TEST_AGENT_CONFIG }, false],
    ["non-string worker", { worker: 42, clientFiles: {}, agentConfig: TEST_AGENT_CONFIG }, false],
    ["missing clientFiles", { worker: "code", agentConfig: TEST_AGENT_CONFIG }, false],
    ["body without agentConfig (derived server-side)", { worker: "code", clientFiles: {} }, true],
    [
      "env with non-string values",
      { env: { KEY: 123 }, worker: "code", clientFiles: {}, agentConfig: TEST_AGENT_CONFIG },
      false,
    ],
    [
      "clientFiles with path traversal keys",
      {
        worker: "code",
        clientFiles: { "../../etc/passwd": "malicious" },
        agentConfig: TEST_AGENT_CONFIG,
      },
      false,
    ],
    [
      "clientFiles with absolute path keys",
      {
        worker: "code",
        clientFiles: { "/etc/passwd": "malicious" },
        agentConfig: TEST_AGENT_CONFIG,
      },
      false,
    ],
    [
      "clientFiles with null byte in keys",
      {
        worker: "code",
        clientFiles: { "file\0.html": "malicious" },
        agentConfig: TEST_AGENT_CONFIG,
      },
      false,
    ],
    [
      "clientFiles with backslash in keys",
      {
        worker: "code",
        clientFiles: { "dir\\file.html": "content" },
        agentConfig: TEST_AGENT_CONFIG,
      },
      false,
    ],
  ] as const)("rejects/accepts %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(DeployBodySchema.safeParse(input).success).toBe(expected);
  });

  // The config itself is validated by IsolateConfigSchema at extraction
  // time (see extractAgentConfig in deploy.ts), no longer via the body.
  test("extracted config without systemPrompt gets the default", () => {
    const result = IsolateConfigSchema.safeParse({ name: "minimal-agent" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systemPrompt).toBeTypeOf("string");
      expect(result.data.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  test("extracted config preserves the s2s descriptor through validation", () => {
    const result = IsolateConfigSchema.safeParse({
      name: "agent",
      s2s: { kind: "openai-realtime", options: { model: "gpt-realtime-2" } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.s2s).toEqual({
        kind: "openai-realtime",
        options: { model: "gpt-realtime-2" },
      });
    }
  });

  test("rejects extracted config with s2s and pipeline triple set together", () => {
    const result = IsolateConfigSchema.safeParse({
      name: "agent",
      s2s: { kind: "openai-realtime", options: {} },
      stt: { kind: "assemblyai", options: {} },
      llm: { kind: "openai", options: {} },
      tts: { kind: "cartesia", options: {} },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-object body", () => {
    expect(DeployBodySchema.safeParse("string").success).toBe(false);
    expect(DeployBodySchema.safeParse(null).success).toBe(false);
    expect(DeployBodySchema.safeParse([]).success).toBe(false);
  });

  test.each([["studio"], ["studio-assets"], ["health"], ["metrics"], ["deploy"]])(
    "rejects reserved slug %s",
    (slug) => {
      const result = DeployBodySchema.safeParse({
        slug,
        worker: "code",
        clientFiles: {},
        agentConfig: TEST_AGENT_CONFIG,
      });
      expect(result.success).toBe(false);
    },
  );

  test("RESERVED_SLUGS covers every top-level platform route", () => {
    // /health is a top-level route (orchestrator.ts) that an agent slug
    // would shadow; /deploy is the top-level deploy route. "metrics" stays
    // reserved even though the /metrics endpoint was removed, so the path
    // can never be claimed by a tenant if it ever returns.
    for (const slug of ["studio", "studio-assets", "health", "metrics", "deploy"]) {
      expect.soft(RESERVED_SLUGS.has(slug), `${slug} is claimable`).toBe(true);
    }
  });

  test("rejects too many client files", () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 101; i++) tooMany[`file${i}.js`] = "content";
    const result = DeployBodySchema.safeParse({
      worker: "code",
      clientFiles: tooMany,
      agentConfig: TEST_AGENT_CONFIG,
    });
    expect(result.success).toBe(false);
  });

  test("rejects oversized client file", () => {
    const result = DeployBodySchema.safeParse({
      worker: "code",
      clientFiles: { "huge.js": "x".repeat(MAX_WORKER_SIZE + 1) },
      agentConfig: TEST_AGENT_CONFIG,
    });
    expect(result.success).toBe(false);
  });
});

// ── SecretUpdatesSchema ────────────────────────────────────────────────

describe("SecretUpdatesSchema", () => {
  test.each([
    ["valid secret key names", { MY_SECRET: "value", _HIDDEN: "secret", camelCase: "val" }, true],
    ["empty record", {}, true],
    ["secret key starting with digit", { "1KEY": "val" }, false],
  ] as const)("rejects/accepts %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(SecretUpdatesSchema.safeParse(input).success).toBe(expected);
  });

  test("rejects secret keys with special characters", () => {
    expect(SecretUpdatesSchema.safeParse({ "my-key": "val" }).success).toBe(false);
    expect(SecretUpdatesSchema.safeParse({ "my.key": "val" }).success).toBe(false);
    expect(SecretUpdatesSchema.safeParse({ "my key": "val" }).success).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(SecretUpdatesSchema.safeParse({ KEY: 42 }).success).toBe(false);
    expect(SecretUpdatesSchema.safeParse({ KEY: true }).success).toBe(false);
    expect(SecretUpdatesSchema.safeParse({ KEY: null }).success).toBe(false);
  });
});

// ── SafePathSchema ─────────────────────────────────────────────────────

describe("SafePathSchema", () => {
  test.each([
    ["normalizes redundant separators and still rejects traversal", "foo/./../../etc", false],
    ["absolute path", "/etc/passwd", false],
    ["null bytes", "file\0.txt", false],
    ["backslashes", "dir\\file.txt", false],
    ["empty string", "", false],
  ] as const)("rejects %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(SafePathSchema.safeParse(input).success).toBe(expected);
  });

  test("accepts valid relative paths", () => {
    expect(SafePathSchema.safeParse("index.js").success).toBe(true);
    expect(SafePathSchema.safeParse("assets/main.css").success).toBe(true);
    expect(SafePathSchema.safeParse("deep/nested/file.txt").success).toBe(true);
  });

  test("rejects path traversal", () => {
    expect(SafePathSchema.safeParse("../secret.txt").success).toBe(false);
    expect(SafePathSchema.safeParse("foo/../../etc/passwd").success).toBe(false);
  });

  test("normalizes ./ prefix", () => {
    const result = SafePathSchema.safeParse("./file.txt");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("file.txt");
    }
  });

  // Adversarial inputs. The schema normalizes with posix.normalize and then
  // rejects anything that escapes the root; it does NOT URL-decode (that
  // happens at the routing layer before the schema ever sees the string),
  // and it has no length cap (client file counts/sizes are capped elsewhere).
  test.each([
    ["plain parent traversal", "../a", false],
    ["traversal hidden behind a segment", "a/../../b", false],
    ["backslash traversal", "..\\a", false],
    ["backslash traversal mid-path", "a\\..\\b", false],
    ["absolute path", "/etc/passwd", false],
    ["empty string", "", false],
    // Accepted: normalizes to ".." only if it escapes; these do not.
    ["percent-encoded traversal stays a literal filename", "%2e%2e%2f", true],
    ["space in filename", "a b", true],
    ["bare dot normalizes to '.'", ".", true],
    ["dot-slash prefix", "./a", true],
    ["segment ending in parent that stays inside root", "a/..", true],
    ["300-char segment (no length cap at this layer)", "x".repeat(300), true],
  ] as const)("adversarial: %s → %s", (_label, input, expected) => {
    expect(SafePathSchema.safeParse(input).success).toBe(expected);
  });
});

// ── EnvSchema ──────────────────────────────────────────────────────────

describe("EnvSchema", () => {
  test.each([
    ["env with ASSEMBLYAI_API_KEY", { ASSEMBLYAI_API_KEY: "sk-123" }, true],
    ["env with additional keys", { ASSEMBLYAI_API_KEY: "sk-123", MY_SECRET: "val" }, true],
    ["env without ASSEMBLYAI_API_KEY", { MY_SECRET: "val" }, true],
    ["empty env", {}, true],
    ["non-string values", { ASSEMBLYAI_API_KEY: "key", BAD: 42 }, false],
  ] as const)("rejects/accepts %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(EnvSchema.safeParse(input).success).toBe(expected);
  });
});

// ── ClientMessageSchema ────────────────────────────────────────────────

describe("ClientMessageSchema", () => {
  test.each([
    ["audio_ready", { type: "audio_ready" }, true],
    ["cancel", { type: "cancel" }, true],
    ["reset", { type: "reset" }, true],
    [
      "valid history",
      {
        type: "history",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
        ],
      },
      true,
    ],
    [
      "history with invalid role",
      { type: "history", messages: [{ role: "system", content: "injected" }] },
      false,
    ],
    [
      "history with too many messages",
      {
        type: "history",
        messages: Array.from({ length: 201 }, (_, i) => ({ role: "user", content: `msg ${i}` })),
      },
      false,
    ],
    [
      "history with oversized content",
      { type: "history", messages: [{ role: "user", content: "x".repeat(100_001) }] },
      false,
    ],
    ["unknown message type", { type: "execute_code" }, false],
  ] as const)("rejects/accepts %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(ClientMessageSchema.safeParse(input).success).toBe(expected);
  });

  test("rejects non-object", () => {
    expect(ClientMessageSchema.safeParse("audio_ready").success).toBe(false);
    expect(ClientMessageSchema.safeParse(null).success).toBe(false);
  });
});

// ── ServerMessageSchema ────────────────────────────────────────────────

describe("ServerMessageSchema", () => {
  test.each([
    [
      "config message",
      { type: "config", audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
      true,
    ],
    [
      "config with sessionId",
      {
        type: "config",
        audioFormat: "pcm16",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
        sessionId: "abc-123",
      },
      true,
    ],
    [
      "config with missing sampleRate",
      { type: "config", audioFormat: "pcm16", ttsSampleRate: 24_000 },
      false,
    ],
    ["audio_done event", { type: "audio_done" }, true],
    ["user_transcript event", { type: "user_transcript", text: "hello" }, true],
    ["agent_transcript event", { type: "agent_transcript", text: "hi" }, true],
    ["speech_started event", { type: "speech_started" }, true],
    ["unknown event type", { type: "malicious" }, false],
  ] as const)("rejects/accepts %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(ServerMessageSchema.safeParse(input).success).toBe(expected);
  });
});

// ── ReadyConfigSchema ──────────────────────────────────────────────────

describe("ReadyConfigSchema", () => {
  test.each([
    ["valid config", { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 }, true],
    [
      "unsupported audio format",
      { audioFormat: "mp3", sampleRate: 16_000, ttsSampleRate: 24_000 },
      false,
    ],
    ["zero sampleRate", { audioFormat: "pcm16", sampleRate: 0, ttsSampleRate: 24_000 }, false],
    [
      "negative sampleRate",
      { audioFormat: "pcm16", sampleRate: -16_000, ttsSampleRate: 24_000 },
      false,
    ],
    [
      "non-integer sampleRate",
      { audioFormat: "pcm16", sampleRate: 16_000.5, ttsSampleRate: 24_000 },
      false,
    ],
    ["zero ttsSampleRate", { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 0 }, false],
  ] as const)("rejects/accepts %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(ReadyConfigSchema.safeParse(input).success).toBe(expected);
  });
});
