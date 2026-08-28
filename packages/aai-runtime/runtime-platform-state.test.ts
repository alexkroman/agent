// Copyright 2026 the AAI authors. MIT license.
/**
 * Which session-state backend `createRuntime` resolves, and from WHERE.
 *
 * Its own file rather than a block in `runtime.test.ts`, which is at its length
 * cap — and the separation is honest anyway: this is about one decision made at
 * construction, and the door a caller takes to reach it.
 *
 * That door is the point. `runtime-session-state.test.ts` covers
 * `createRuntimeSessionState` directly and is handed `platform` explicitly, so it
 * could never see that `createRuntime` was resolving the platform pair out of the
 * wrong environment — which it was, for every deployed agent.
 */

import { describe, expect, test, vi } from "vitest";
import { makeAgent, makeLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";

describe("the platform session-state backend", () => {
  /**
   * The pair the platform bakes into a sandbox — and the door a caller really
   * takes, which is the point of testing it HERE. `runtime-session-state.test.ts`
   * covers `createRuntimeSessionState` directly, is handed `platform` explicitly,
   * and so could never see that `createRuntime` was resolving it from the wrong
   * environment. Every deployed agent ran on the memory backend: history and slots
   * died with the sandbox, `aai_platform.session_events` stayed empty, and a resume
   * after a restart re-greeted instead of restoring. See `platformGuestOptions`.
   */
  const BASE = "https://platform.example/my-agent";
  const TOKEN = "guest-bearer";

  /** What `createRuntime` reported at boot, which is where the tier is legible. */
  function resolvedBackend(logger: ReturnType<typeof makeLogger>): unknown {
    const line = logger.info.mock.calls.find(([message]) => message === "Session mode resolved");
    return (line?.[1] as { sessionState?: unknown } | undefined)?.sessionState;
  }

  test("comes from the PROCESS env, where the platform puts it", () => {
    vi.stubEnv("AAI_PUBLIC_BASE_URL", BASE);
    vi.stubEnv("AAI_GUEST_TOKEN", TOKEN);
    const logger = makeLogger();

    createRuntime({ agent: makeAgent(), env: {}, logger });

    expect(resolvedBackend(logger)).toEqual({ backend: "platform", durable: true });
  });

  test("is NOT taken from the agent's own env, which a tenant controls", () => {
    // `agentServerEnv` strips only `AAI_ALLOW_HOST`, so an agent may set any other
    // `AAI_*` key as a secret. Under the old spelling that let it choose the base
    // URL its session state was posted to, and the bearer sent with it.
    vi.stubEnv("AAI_PUBLIC_BASE_URL", undefined);
    vi.stubEnv("AAI_GUEST_TOKEN", undefined);
    const logger = makeLogger();

    createRuntime({
      agent: makeAgent(),
      env: { AAI_PUBLIC_BASE_URL: "https://attacker.example", AAI_GUEST_TOKEN: "theirs" },
      logger,
    });

    expect(resolvedBackend(logger)).toEqual({ backend: "memory", durable: false });
  });
});
