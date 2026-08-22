// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { requireApiKey } from "./_utils.ts";
import { PROVIDER_CREDENTIAL_ENVS, withHostCredentialFallback } from "./host-env.ts";
import { resolveApiKey } from "./resolve.ts";

describe("resolveApiKey", () => {
  test("reads the credential from the agent env", () => {
    expect(resolveApiKey("ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: "sk-agent" })).toBe("sk-agent");
  });

  test("returns empty string when the agent env lacks the credential", () => {
    expect(resolveApiKey("ANTHROPIC_API_KEY", {})).toBe("");
  });

  // The platform host process may hold platform-owned credentials under
  // exactly these names. Falling back to process.env would hand them to any
  // tenant that supplied no credential of its own.
  test("does not fall back to the host process environment", () => {
    const key = "AAI_TEST_FALLBACK_KEY";
    vi.stubEnv(key, "platform-secret");
    expect(resolveApiKey(key, {})).toBe("");
  });
});

// The second credential path: every STT/TTS opener and every LLM (via
// resolve.ts's requireKey) resolve through this one, so a process.env
// fallback here reopens the whole leak even with resolveApiKey sealed.
describe("requireApiKey", () => {
  const fail = (msg: string) => new Error(msg);

  test("returns the credential the runtime supplied", () => {
    expect(requireApiKey("sk-agent", "ANTHROPIC_API_KEY", "Anthropic", fail)).toBe("sk-agent");
  });

  test("does not fall back to the host process environment", () => {
    const key = "AAI_TEST_REQUIRE_KEY";
    vi.stubEnv(key, "platform-secret");
    expect(() => requireApiKey("", key, "Test provider", fail)).toThrow(/missing API key/);
    expect(() => requireApiKey(undefined, key, "Test provider", fail)).toThrow(/missing API key/);
  });

  test("names the env var to set", () => {
    expect(() => requireApiKey("", "CARTESIA_API_KEY", "Cartesia TTS", fail)).toThrow(
      /Set CARTESIA_API_KEY in the agent env/,
    );
  });
});

describe("withHostCredentialFallback", () => {
  test("fills in a missing provider credential from the host env", () => {
    const merged = withHostCredentialFallback({}, { ANTHROPIC_API_KEY: "sk-shell" });
    expect(merged.ANTHROPIC_API_KEY).toBe("sk-shell");
  });

  test("never overrides a value already in the agent env", () => {
    const merged = withHostCredentialFallback(
      { ANTHROPIC_API_KEY: "sk-dotenv" },
      { ANTHROPIC_API_KEY: "sk-shell" },
    );
    expect(merged.ANTHROPIC_API_KEY).toBe("sk-dotenv");
  });

  test("copies only provider credential names, not arbitrary host vars", () => {
    const merged = withHostCredentialFallback(
      {},
      {
        ANTHROPIC_API_KEY: "sk-shell",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        BUCKET_NAME: "platform-bucket",
        PATH: "/usr/bin",
      },
    );
    expect(merged.ANTHROPIC_API_KEY).toBe("sk-shell");
    // Not provider credentials — must not leak into ctx.env.
    expect(merged.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(merged.BUCKET_NAME).toBeUndefined();
    expect(merged.PATH).toBeUndefined();
  });

  test("ignores empty host values", () => {
    const merged = withHostCredentialFallback({}, { ANTHROPIC_API_KEY: "" });
    expect(merged.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("does not mutate the input env", () => {
    const env: Record<string, string> = {};
    withHostCredentialFallback(env, { ANTHROPIC_API_KEY: "sk-shell" });
    expect(env).toEqual({});
  });

  // Derived from the provider registries, so a new provider is covered without
  // touching this list. These assertions catch the derivation breaking, not the
  // list going stale.
  test("covers STT, TTS, LLM and S2S credential names", () => {
    for (const name of [
      "ASSEMBLYAI_API_KEY", // STT + default S2S
      "DEEPGRAM_API_KEY",
      "ELEVENLABS_API_KEY",
      "SONIOX_API_KEY",
      "CARTESIA_API_KEY", // TTS
      "RIME_API_KEY",
      "ANTHROPIC_API_KEY", // LLM
      "OPENAI_API_KEY", // LLM + OpenAI Realtime S2S
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "MISTRAL_API_KEY",
      "XAI_API_KEY",
      "GROQ_API_KEY",
      "AI_GATEWAY_API_KEY",
    ]) {
      // Soft: a broken derivation drops a whole provider family, and the set
      // of missing names is what points at which registry stopped feeding it.
      expect.soft(PROVIDER_CREDENTIAL_ENVS, name).toContain(name);
    }
  });

  test("contains no duplicates", () => {
    expect(PROVIDER_CREDENTIAL_ENVS.length).toBe(new Set(PROVIDER_CREDENTIAL_ENVS).size);
  });

  test("every fallback name is resolvable by resolveApiKey", () => {
    const hostEnv = Object.fromEntries(PROVIDER_CREDENTIAL_ENVS.map((n) => [n, `value-${n}`]));
    const merged = withHostCredentialFallback({}, hostEnv);
    for (const name of PROVIDER_CREDENTIAL_ENVS) {
      expect.soft(resolveApiKey(name, merged), name).toBe(`value-${name}`);
    }
  });
});
