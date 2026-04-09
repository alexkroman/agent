// Copyright 2025 the AAI authors. MIT license.
import {
  ClientMessageSchema,
  KvRequestSchema,
  ReadyConfigSchema,
  ServerMessageSchema,
} from "@alexkroman1/aai-core/protocol";
import { describe, expect, test } from "vitest";
import {
  AgentMetadataSchema,
  DeployBodySchema,
  EnvSchema,
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
    ["missing agentConfig", { worker: "code", clientFiles: {} }, false],
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

  test("rejects non-object body", () => {
    expect(DeployBodySchema.safeParse("string").success).toBe(false);
    expect(DeployBodySchema.safeParse(null).success).toBe(false);
    expect(DeployBodySchema.safeParse([]).success).toBe(false);
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
      clientFiles: { "huge.js": "x".repeat(10_000_001) },
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

// ── AgentMetadataSchema ────────────────────────────────────────────────

describe("AgentMetadataSchema", () => {
  test.each([
    [
      "full metadata",
      { slug: "my-agent", env: { KEY: "val" }, credential_hashes: ["abc123"] },
      true,
    ],
    ["missing slug", { env: {} }, false],
    ["non-string slug", { slug: 42 }, false],
  ] as const)("rejects/accepts %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(AgentMetadataSchema.safeParse(input).success).toBe(expected);
  });

  test("accepts minimal metadata", () => {
    const result = AgentMetadataSchema.safeParse({ slug: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env).toEqual({});
    }
  });

  test("defaults env to empty object", () => {
    const result = AgentMetadataSchema.safeParse({ slug: "agent" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env).toEqual({});
      expect(result.data.credential_hashes).toEqual([]);
    }
  });

  test("rejects non-object", () => {
    expect(AgentMetadataSchema.safeParse("agent").success).toBe(false);
    expect(AgentMetadataSchema.safeParse(null).success).toBe(false);
  });
});

// ── KvRequestSchema ────────────────────────────────────────────────────

describe("KvRequestSchema", () => {
  test.each([
    ["valid get request", { op: "get", key: "mykey" }, true],
    ["get with empty key", { op: "get", key: "" }, false],
    ["get with missing key", { op: "get" }, false],
    ["valid set request", { op: "set", key: "k", value: "v" }, true],
    ["set with expireIn", { op: "set", key: "k", value: "v", expireIn: 60_000 }, true],
    ["set with negative expireIn", { op: "set", key: "k", value: "v", expireIn: -1 }, false],
    ["set with non-integer expireIn", { op: "set", key: "k", value: "v", expireIn: 1.5 }, false],
    ["valid del request", { op: "del", key: "k" }, true],
    ["list with negative limit", { op: "list", prefix: "", limit: -1 }, false],
    ["unknown op", { op: "drop_table" }, false],
  ] as const)("rejects/accepts %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(KvRequestSchema.safeParse(input).success).toBe(expected);
  });

  test("rejects non-object", () => {
    expect(KvRequestSchema.safeParse("get").success).toBe(false);
    expect(KvRequestSchema.safeParse(null).success).toBe(false);
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
