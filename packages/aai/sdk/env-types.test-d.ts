// Copyright 2026 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import type { AgentEnv, HostCredentialEnv, ProviderEnv } from "./env-types.ts";

/**
 * The credential-separation rule, as assignability facts. If the strong
 * direction (HostCredentialEnv ↛ AgentEnv) ever loosens, host/shell
 * credentials can silently become `ctx.env` again — the exact bug family
 * the brands exist to stop.
 */

test("a plain record satisfies both AgentEnv and ProviderEnv", () => {
  expectTypeOf<Record<string, string>>().toExtend<AgentEnv>();
  expectTypeOf<Record<string, string>>().toExtend<ProviderEnv>();
});

test("an AgentEnv is usable for provider-credential resolution", () => {
  expectTypeOf<AgentEnv>().toExtend<ProviderEnv>();
});

test("a HostCredentialEnv is usable for provider-credential resolution", () => {
  expectTypeOf<HostCredentialEnv>().toExtend<ProviderEnv>();
});

test("a HostCredentialEnv must NOT satisfy AgentEnv (never becomes ctx.env)", () => {
  expectTypeOf<HostCredentialEnv>().not.toExtend<AgentEnv>();
});

test("a ProviderEnv of unknown provenance must NOT satisfy AgentEnv", () => {
  // Only concrete agent-owned records may become ctx.env; a value typed as
  // the wider ProviderEnv might be a HostCredentialEnv underneath.
  expectTypeOf<ProviderEnv>().not.toExtend<AgentEnv>();
});
