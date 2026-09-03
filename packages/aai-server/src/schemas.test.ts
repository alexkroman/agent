// Copyright 2025 the AAI authors. MIT license.
import {
  ReadyConfigSchema,
  SessionCommandSchema,
  SessionEventSchema,
} from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import { MAX_WORKER_SIZE } from "./constants.ts";
import {
  DeployBodySchema,
  EnvSchema,
  RESERVED_SLUGS,
  SafePathSchema,
  SecretUpdatesSchema,
} from "./schemas.ts";

// ── DeployBodySchema ───────────────────────────────────────────────────

describe("DeployBodySchema", () => {
  test.each([
    [
      "valid deploy body",
      {
        worker: "console.log('hello');",
        clientFiles: { "index.html": "<html></html>" },
      },
      true,
    ],
    [
      "deploy body with env",
      {
        env: { MY_SECRET: "value" },
        worker: "console.log('hello');",
        clientFiles: {},
      },
      true,
    ],
    ["missing worker field", { clientFiles: {} }, false],
    ["empty worker string", { worker: "", clientFiles: {} }, false],
    ["non-string worker", { worker: 42, clientFiles: {} }, false],
    ["missing clientFiles", { worker: "code" }, false],
    ["body with only the required fields", { worker: "code", clientFiles: {} }, true],
    ["env with non-string values", { env: { KEY: 123 }, worker: "code", clientFiles: {} }, false],
    [
      "clientFiles with path traversal keys",
      {
        worker: "code",
        clientFiles: { "../../etc/passwd": "malicious" },
      },
      false,
    ],
    [
      "clientFiles with absolute path keys",
      {
        worker: "code",
        clientFiles: { "/etc/passwd": "malicious" },
      },
      false,
    ],
    [
      "clientFiles with null byte in keys",
      {
        worker: "code",
        clientFiles: { "file\0.html": "malicious" },
      },
      false,
    ],
    [
      "clientFiles with backslash in keys",
      {
        worker: "code",
        clientFiles: { "dir\\file.html": "content" },
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

  test.each([["studio"], ["studio-assets"], ["health"], ["metrics"], ["deploy"]])(
    "rejects reserved slug %s",
    (slug) => {
      const result = DeployBodySchema.safeParse({
        slug,
        worker: "code",
        clientFiles: {},
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
    });
    expect(result.success).toBe(false);
  });

  test("rejects oversized client file", () => {
    const result = DeployBodySchema.safeParse({
      worker: "code",
      clientFiles: { "huge.js": "x".repeat(MAX_WORKER_SIZE + 1) },
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

// ── SessionCommandSchema ────────────────────────────────────────────────

describe("SessionCommandSchema", () => {
  test.each([
    ["audio_ready", { type: "audio_ready" }, true],
    ["cancel", { type: "cancel" }, true],
    ["reset", { type: "reset" }, true],
    ["playback_progress", { type: "playback_progress", bufferedMs: 250 }, true],
    [
      "playback_progress with a negative buffer",
      { type: "playback_progress", bufferedMs: -1 },
      false,
    ],
    ["tool_result", { type: "tool_result", toolCallId: "tc1", result: "ok" }, true],
    ["tool_result with no call id", { type: "tool_result", toolCallId: "", result: "ok" }, false],
    // The `history` frame is GONE. A reconnecting client used to push its own
    // `messages` back, which made it the authority on the agent's memory — and
    // made this schema the platform's only guard on a client-supplied
    // conversation (hence the role, count and size cases this replaces). The
    // server restores from its own retained event stream now, so there is no
    // client-supplied history to validate.
    ["history", { type: "history", messages: [{ role: "user", content: "hello" }] }, false],
    ["unknown message type", { type: "execute_code" }, false],
  ] as const)("rejects/accepts %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(SessionCommandSchema.safeParse(input).success).toBe(expected);
  });

  test("rejects non-object", () => {
    expect(SessionCommandSchema.safeParse("audio_ready").success).toBe(false);
    expect(SessionCommandSchema.safeParse(null).success).toBe(false);
  });
});

// ── SessionEventSchema ────────────────────────────────────────────────

describe("SessionEventSchema", () => {
  // Bodies, with the envelope supplied below — every server frame carries one
  // now, and these cases are about the frame's own shape.
  const META = { id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV", at: 1_700_000_000_000 };
  test.each([
    [
      "handshake",
      {
        type: "session.configured",
        audioFormat: "pcm16",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
      },
      true,
    ],
    [
      "handshake with sessionId",
      {
        type: "session.configured",
        audioFormat: "pcm16",
        sampleRate: 16_000,
        ttsSampleRate: 24_000,
        sessionId: "abc-123",
      },
      true,
    ],
    [
      "handshake with missing sampleRate",
      { type: "session.configured", audioFormat: "pcm16", ttsSampleRate: 24_000 },
      false,
    ],
    ["audio.completed", { type: "audio.completed" }, true],
    ["user-transcript.committed", { type: "user-transcript.committed", text: "hello" }, true],
    ["agent-transcript.updated", { type: "agent-transcript.updated", text: "hi" }, true],
    ["speech.started", { type: "speech.started" }, true],
    ["unknown event type", { type: "malicious" }, false],
  ] as const)("rejects/accepts %s → %s", (_label: string, input: unknown, expected: boolean) => {
    expect(SessionEventSchema.safeParse({ ...(input as object), meta: META }).success).toBe(
      expected,
    );
  });

  test("an event with no envelope is refused", () => {
    // The envelope is REQUIRED, so a platform-side reader cannot be handed a
    // frame with no `meta.id` to key on.
    expect(SessionEventSchema.safeParse({ type: "speech.started" }).success).toBe(false);
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
