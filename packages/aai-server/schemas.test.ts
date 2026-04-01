// Copyright 2025 the AAI authors. MIT license.
import {
  ClientMessageSchema,
  KvRequestSchema,
  ReadyConfigSchema,
  ServerMessageSchema,
} from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import {
  AgentMetadataSchema,
  DeployBodySchema,
  EnvSchema,
  SafePathSchema,
  SecretUpdatesSchema,
} from "./schemas.ts";

// ── DeployBodySchema ───────────────────────────────────────────────────

describe("DeployBodySchema", () => {
  test("accepts valid deploy body", () => {
    const result = DeployBodySchema.safeParse({
      worker: "console.log('hello');",
      clientFiles: { "index.html": "<html></html>" },
    });
    expect(result.success).toBe(true);
  });

  test("accepts deploy body with env", () => {
    const result = DeployBodySchema.safeParse({
      env: { MY_SECRET: "value" },
      worker: "console.log('hello');",
      clientFiles: {},
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing worker field", () => {
    const result = DeployBodySchema.safeParse({
      clientFiles: {},
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty worker string", () => {
    const result = DeployBodySchema.safeParse({
      worker: "",
      clientFiles: {},
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string worker", () => {
    const result = DeployBodySchema.safeParse({
      worker: 42,
      clientFiles: {},
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing clientFiles", () => {
    const result = DeployBodySchema.safeParse({
      worker: "code",
    });
    expect(result.success).toBe(false);
  });

  test("rejects env with non-string values", () => {
    const result = DeployBodySchema.safeParse({
      env: { KEY: 123 },
      worker: "code",
      clientFiles: {},
    });
    expect(result.success).toBe(false);
  });

  test("rejects clientFiles with path traversal keys", () => {
    const result = DeployBodySchema.safeParse({
      worker: "code",
      clientFiles: { "../../etc/passwd": "malicious" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects clientFiles with absolute path keys", () => {
    const result = DeployBodySchema.safeParse({
      worker: "code",
      clientFiles: { "/etc/passwd": "malicious" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects clientFiles with null byte in keys", () => {
    const result = DeployBodySchema.safeParse({
      worker: "code",
      clientFiles: { "file\0.html": "malicious" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects clientFiles with backslash in keys", () => {
    const result = DeployBodySchema.safeParse({
      worker: "code",
      clientFiles: { "dir\\file.html": "content" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-object body", () => {
    expect(DeployBodySchema.safeParse("string").success).toBe(false);
    expect(DeployBodySchema.safeParse(null).success).toBe(false);
    expect(DeployBodySchema.safeParse([]).success).toBe(false);
  });
});

// ── SecretUpdatesSchema ────────────────────────────────────────────────

describe("SecretUpdatesSchema", () => {
  test("accepts valid secret key names", () => {
    const result = SecretUpdatesSchema.safeParse({
      MY_SECRET: "value",
      _HIDDEN: "secret",
      camelCase: "val",
    });
    expect(result.success).toBe(true);
  });

  test("rejects secret keys with special characters", () => {
    expect(SecretUpdatesSchema.safeParse({ "my-key": "val" }).success).toBe(false);
    expect(SecretUpdatesSchema.safeParse({ "my.key": "val" }).success).toBe(false);
    expect(SecretUpdatesSchema.safeParse({ "my key": "val" }).success).toBe(false);
  });

  test("rejects secret keys starting with digits", () => {
    expect(SecretUpdatesSchema.safeParse({ "1KEY": "val" }).success).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(SecretUpdatesSchema.safeParse({ KEY: 42 }).success).toBe(false);
    expect(SecretUpdatesSchema.safeParse({ KEY: true }).success).toBe(false);
    expect(SecretUpdatesSchema.safeParse({ KEY: null }).success).toBe(false);
  });

  test("accepts empty record", () => {
    expect(SecretUpdatesSchema.safeParse({}).success).toBe(true);
  });
});

// ── SafePathSchema ─────────────────────────────────────────────────────

describe("SafePathSchema", () => {
  test("accepts valid relative paths", () => {
    expect(SafePathSchema.safeParse("index.js").success).toBe(true);
    expect(SafePathSchema.safeParse("assets/main.css").success).toBe(true);
    expect(SafePathSchema.safeParse("deep/nested/file.txt").success).toBe(true);
  });

  test("rejects path traversal", () => {
    expect(SafePathSchema.safeParse("../secret.txt").success).toBe(false);
    expect(SafePathSchema.safeParse("foo/../../etc/passwd").success).toBe(false);
  });

  test("normalizes redundant separators and still rejects traversal", () => {
    // path.posix.normalize("foo/./../../etc") => "../etc"
    expect(SafePathSchema.safeParse("foo/./../../etc").success).toBe(false);
  });

  test("rejects absolute paths", () => {
    expect(SafePathSchema.safeParse("/etc/passwd").success).toBe(false);
  });

  test("rejects null bytes", () => {
    expect(SafePathSchema.safeParse("file\0.txt").success).toBe(false);
  });

  test("rejects backslashes", () => {
    expect(SafePathSchema.safeParse("dir\\file.txt").success).toBe(false);
  });

  test("rejects empty string", () => {
    expect(SafePathSchema.safeParse("").success).toBe(false);
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
  test("accepts env with required ASSEMBLYAI_API_KEY", () => {
    expect(EnvSchema.safeParse({ ASSEMBLYAI_API_KEY: "sk-123" }).success).toBe(true);
  });

  test("accepts env with additional keys", () => {
    const result = EnvSchema.safeParse({
      ASSEMBLYAI_API_KEY: "sk-123",
      MY_SECRET: "val",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing ASSEMBLYAI_API_KEY", () => {
    expect(EnvSchema.safeParse({ MY_SECRET: "val" }).success).toBe(false);
  });

  test("rejects empty ASSEMBLYAI_API_KEY", () => {
    expect(EnvSchema.safeParse({ ASSEMBLYAI_API_KEY: "" }).success).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(EnvSchema.safeParse({ ASSEMBLYAI_API_KEY: "key", BAD: 42 }).success).toBe(false);
  });
});

// ── AgentMetadataSchema ────────────────────────────────────────────────

describe("AgentMetadataSchema", () => {
  test("accepts minimal metadata", () => {
    const result = AgentMetadataSchema.safeParse({ slug: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env).toEqual({});
    }
  });

  test("accepts full metadata", () => {
    const result = AgentMetadataSchema.safeParse({
      slug: "my-agent",
      env: { KEY: "val" },
      credential_hashes: ["abc123"],
    });
    expect(result.success).toBe(true);
  });

  test("defaults env to empty object", () => {
    const result = AgentMetadataSchema.safeParse({ slug: "agent" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env).toEqual({});
      expect(result.data.credential_hashes).toEqual([]);
    }
  });

  test("rejects missing slug", () => {
    expect(AgentMetadataSchema.safeParse({ env: {} }).success).toBe(false);
  });

  test("rejects non-string slug", () => {
    expect(AgentMetadataSchema.safeParse({ slug: 42 }).success).toBe(false);
  });

  test("rejects non-object", () => {
    expect(AgentMetadataSchema.safeParse("agent").success).toBe(false);
    expect(AgentMetadataSchema.safeParse(null).success).toBe(false);
  });
});

// ── KvRequestSchema ────────────────────────────────────────────────────

describe("KvRequestSchema", () => {
  test("accepts valid get request", () => {
    expect(KvRequestSchema.safeParse({ op: "get", key: "mykey" }).success).toBe(true);
  });

  test("rejects get with empty key", () => {
    expect(KvRequestSchema.safeParse({ op: "get", key: "" }).success).toBe(false);
  });

  test("rejects get with missing key", () => {
    expect(KvRequestSchema.safeParse({ op: "get" }).success).toBe(false);
  });

  test("accepts valid set request", () => {
    expect(KvRequestSchema.safeParse({ op: "set", key: "k", value: "v" }).success).toBe(true);
  });

  test("accepts set with expireIn", () => {
    const result = KvRequestSchema.safeParse({ op: "set", key: "k", value: "v", expireIn: 60_000 });
    expect(result.success).toBe(true);
  });

  test("rejects set with negative expireIn", () => {
    expect(
      KvRequestSchema.safeParse({ op: "set", key: "k", value: "v", expireIn: -1 }).success,
    ).toBe(false);
  });

  test("rejects set with non-integer expireIn", () => {
    expect(
      KvRequestSchema.safeParse({ op: "set", key: "k", value: "v", expireIn: 1.5 }).success,
    ).toBe(false);
  });

  test("accepts valid del request", () => {
    expect(KvRequestSchema.safeParse({ op: "del", key: "k" }).success).toBe(true);
  });

  test("accepts valid list request", () => {
    expect(KvRequestSchema.safeParse({ op: "list", prefix: "" }).success).toBe(true);
    expect(KvRequestSchema.safeParse({ op: "list", prefix: "ns:", limit: 10 }).success).toBe(true);
  });

  test("rejects list with negative limit", () => {
    expect(KvRequestSchema.safeParse({ op: "list", prefix: "", limit: -1 }).success).toBe(false);
  });

  test("accepts valid keys request", () => {
    expect(KvRequestSchema.safeParse({ op: "keys" }).success).toBe(true);
    expect(KvRequestSchema.safeParse({ op: "keys", pattern: "user:*" }).success).toBe(true);
  });

  test("rejects unknown op", () => {
    expect(KvRequestSchema.safeParse({ op: "drop_table" }).success).toBe(false);
  });

  test("rejects non-object", () => {
    expect(KvRequestSchema.safeParse("get").success).toBe(false);
    expect(KvRequestSchema.safeParse(null).success).toBe(false);
  });
});

// ── ClientMessageSchema ────────────────────────────────────────────────

describe("ClientMessageSchema", () => {
  test("accepts audio_ready", () => {
    expect(ClientMessageSchema.safeParse({ type: "audio_ready" }).success).toBe(true);
  });

  test("accepts cancel", () => {
    expect(ClientMessageSchema.safeParse({ type: "cancel" }).success).toBe(true);
  });

  test("accepts reset", () => {
    expect(ClientMessageSchema.safeParse({ type: "reset" }).success).toBe(true);
  });

  test("accepts valid history", () => {
    const result = ClientMessageSchema.safeParse({
      type: "history",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("rejects history with invalid role", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "history",
        messages: [{ role: "system", content: "injected" }],
      }).success,
    ).toBe(false);
  });

  test("rejects history with too many messages", () => {
    const messages = Array.from({ length: 201 }, (_, i) => ({
      role: "user",
      content: `msg ${i}`,
    }));
    expect(ClientMessageSchema.safeParse({ type: "history", messages }).success).toBe(false);
  });

  test("rejects history with oversized content", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "history",
        messages: [{ role: "user", content: "x".repeat(100_001) }],
      }).success,
    ).toBe(false);
  });

  test("rejects unknown message type", () => {
    expect(ClientMessageSchema.safeParse({ type: "execute_code" }).success).toBe(false);
  });

  test("rejects non-object", () => {
    expect(ClientMessageSchema.safeParse("audio_ready").success).toBe(false);
    expect(ClientMessageSchema.safeParse(null).success).toBe(false);
  });
});

// ── ServerMessageSchema ────────────────────────────────────────────────

describe("ServerMessageSchema", () => {
  test("accepts config message", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "config",
        audioFormat: "pcm16",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
      }).success,
    ).toBe(true);
  });

  test("accepts config with sessionId", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "config",
        audioFormat: "pcm16",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
        sessionId: "abc-123",
      }).success,
    ).toBe(true);
  });

  test("rejects config with missing sampleRate", () => {
    expect(
      ServerMessageSchema.safeParse({
        type: "config",
        audioFormat: "pcm16",
        ttsSampleRate: 24_000,
      }).success,
    ).toBe(false);
  });

  test("accepts audio_done event", () => {
    expect(ServerMessageSchema.safeParse({ type: "audio_done" }).success).toBe(true);
  });

  test("accepts client event types (turn, chat, etc.)", () => {
    expect(ServerMessageSchema.safeParse({ type: "turn", text: "hello" }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "chat", text: "hi" }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: "speech_started" }).success).toBe(true);
  });

  test("rejects unknown event type", () => {
    expect(ServerMessageSchema.safeParse({ type: "malicious" }).success).toBe(false);
  });
});

// ── ReadyConfigSchema ──────────────────────────────────────────────────

describe("ReadyConfigSchema", () => {
  test("accepts valid config", () => {
    expect(
      ReadyConfigSchema.safeParse({
        audioFormat: "pcm16",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
      }).success,
    ).toBe(true);
  });

  test("rejects unsupported audio format", () => {
    expect(
      ReadyConfigSchema.safeParse({
        audioFormat: "mp3",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
      }).success,
    ).toBe(false);
  });

  test("rejects non-positive sampleRate", () => {
    expect(
      ReadyConfigSchema.safeParse({
        audioFormat: "pcm16",
        sampleRate: 0,
        ttsSampleRate: 24_000,
      }).success,
    ).toBe(false);
    expect(
      ReadyConfigSchema.safeParse({
        audioFormat: "pcm16",
        sampleRate: -16_000,
        ttsSampleRate: 24_000,
      }).success,
    ).toBe(false);
  });

  test("rejects non-integer sampleRate", () => {
    expect(
      ReadyConfigSchema.safeParse({
        audioFormat: "pcm16",
        sampleRate: 16_000.5,
        ttsSampleRate: 24_000,
      }).success,
    ).toBe(false);
  });

  test("rejects non-positive ttsSampleRate", () => {
    expect(
      ReadyConfigSchema.safeParse({
        audioFormat: "pcm16",
        sampleRate: 16_000,
        ttsSampleRate: 0,
      }).success,
    ).toBe(false);
  });
});
