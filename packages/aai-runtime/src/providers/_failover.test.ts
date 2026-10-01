// Copyright 2026 the AAI authors. MIT license.
/**
 * The per-session failover seam: a fallback opener bound to one session's
 * listener, every other opener passed through by identity, and the bound on
 * what a report carries.
 */

import { describe, expect, test } from "vitest";
import { createFailingSttProvider, createFakeSttProvider } from "../_pipeline-test-fakes.ts";
import type { ProviderFailover } from "./_failover.ts";
import { failoverOf, withOpenerFailoverListener } from "./_failover.ts";
import { createFallbackSttOpener } from "./fallback.ts";

const sttOptions = () => ({
  sampleRate: 16_000,
  apiKey: "k",
  signal: new AbortController().signal,
});

test("failoverOf reads an error's message, and a non-error's text", () => {
  expect(failoverOf("llm", "a", "b", new Error("boom"))).toEqual({
    stage: "llm",
    from: "a",
    to: "b",
    reason: "boom",
  });
  expect(failoverOf("tts", "a", "b", "plain").reason).toBe("plain");
});

describe("the per-session listener seam", () => {
  test("binds a fallback opener's open() to the listener", async () => {
    const opener = createFallbackSttOpener(
      [
        { opener: createFailingSttProvider("stt_connect_failed", "x"), envVar: "A", kind: "a" },
        { opener: createFakeSttProvider(), envVar: "B", kind: "b" },
      ],
      {},
    );
    const seen: ProviderFailover[] = [];
    await withOpenerFailoverListener(opener, (f) => seen.push(f)).open(sttOptions());
    expect(seen).toHaveLength(1);
  });

  test("passes any other opener through by identity", async () => {
    const plain = createFakeSttProvider();
    const bound = withOpenerFailoverListener(plain, () => undefined);
    expect(bound).toBe(plain);
    await bound.open(sttOptions());
    expect(plain.sessions).toHaveLength(1);
  });

  test("bounds a reason, which can be a whole error page", async () => {
    const opener = createFallbackSttOpener(
      [
        {
          opener: createFailingSttProvider("stt_connect_failed", "x".repeat(5000)),
          envVar: "A",
          kind: "a",
        },
        { opener: createFakeSttProvider(), envVar: "B", kind: "b" },
      ],
      {},
    );
    const seen: ProviderFailover[] = [];
    await opener.openReporting(sttOptions(), (f) => seen.push(f));
    expect(seen[0]?.reason.length).toBe(500);
  });
});
