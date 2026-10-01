// Copyright 2026 the AAI authors. MIT license.
/**
 * `_dev-agent-env.ts`: the credential warnings `aai dev` / `aai console` print,
 * and `resolveAgentEnv`'s login-key fallback — driven through its
 * `AgentEnvDeps` seam and a fake terminal, against a real `.env` on disk.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { agent } from "@alexkroman1/aai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { type AgentEnvDeps, agentEnvWarnings, resolveAgentEnv } from "./_dev-agent-env.ts";
import { createFakeUi, withTempDir } from "./_test-utils.ts";

describe("agentEnvWarnings", () => {
  const DEFAULT_AGENT = {}; // no descriptors → default AssemblyAI pipeline → needs ASSEMBLYAI_API_KEY

  test("warns when a provider key is missing everywhere", () => {
    const warnings = agentEnvWarnings(DEFAULT_AGENT, {}, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Missing provider credential");
    expect(warnings[0]).toContain("ASSEMBLYAI_API_KEY");
  });

  test("warns about the deploy cliff when a key resolves from the shell only", () => {
    const warnings = agentEnvWarnings(DEFAULT_AGENT, {}, { ASSEMBLYAI_API_KEY: "sk-shell" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("resolved from your shell, not .env");
    expect(warnings[0]).toContain("ASSEMBLYAI_API_KEY");
    expect(warnings[0]).toContain("aai publish");
  });

  test("silent when the key is declared in .env", () => {
    expect(agentEnvWarnings(DEFAULT_AGENT, { ASSEMBLYAI_API_KEY: "sk-env" }, {})).toEqual([]);
  });

  test("a requiredEnv key is flagged even when the shell exports it", () => {
    const agent = { requiredEnv: ["STRIPE_KEY"] };
    const warnings = agentEnvWarnings(
      agent,
      { ASSEMBLYAI_API_KEY: "sk-env" },
      { STRIPE_KEY: "sk-shell" }, // custom keys never fall back to the shell
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("requiredEnv");
    expect(warnings[0]).toContain("STRIPE_KEY");
  });

  test("an MCP tokenEnv and a keyed builtin's key are flagged without a requiredEnv entry", () => {
    const agent = {
      builtinTools: ["brave_search"],
      mcpServers: { docs: { url: "https://mcp.example.com/mcp", tokenEnv: "DOCS_MCP_TOKEN" } },
    };
    const warnings = agentEnvWarnings(agent, { ASSEMBLYAI_API_KEY: "sk-env" }, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DOCS_MCP_TOKEN, BRAVE_API_KEY");
  });

  test("a requiredEnv key present in .env is silent", () => {
    const agent = { requiredEnv: ["STRIPE_KEY"] };
    const env = { ASSEMBLYAI_API_KEY: "sk-env", STRIPE_KEY: "sk-env" };
    expect(agentEnvWarnings(agent, env, {})).toEqual([]);
  });

  test("a workflow app with no credential anywhere warns about nothing", () => {
    // The `page` field has to be in the Pick, or a static agent is warned about
    // a key it never dials — and `resolveAgentEnv` reads the same list to decide
    // whether to reach for the logged-in key, so on that path the same omission
    // is a `missing_assemblyai_key` that stops `aai dev` from starting at all —
    // demanding a credential of an app that dials no provider.
    expect(agentEnvWarnings({ mode: "workflow-app" }, {}, {})).toEqual([]);
  });

  test("a workflow app is still told about its own requiredEnv keys", () => {
    // Suppressing the PROVIDER credential must not suppress the agent's own —
    // a workflow app reads `ctx.env` like any other.
    const warnings = agentEnvWarnings(
      { mode: "workflow-app", requiredEnv: ["STRIPE_KEY"] },
      {},
      {},
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("STRIPE_KEY");
  });
});

describe("resolveAgentEnv", () => {
  beforeEach(() => {
    // The fallback is skipped when the shell has a key; never depend on the machine.
    vi.stubEnv("ASSEMBLYAI_API_KEY", undefined);
  });

  const deps = (key = "login-key") => ({
    ensureApiKey: vi.fn<AgentEnvDeps["ensureApiKey"]>(async () => key),
  });

  test("returns the .env keys and does not reach for the login key when .env has one", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, ".env"), "ASSEMBLYAI_API_KEY=from-env\nOTHER=1\n");
      const d = deps();
      const env = await resolveAgentEnv(dir, agent({ name: "a" }), createFakeUi(), d);
      expect(env).toEqual({ ASSEMBLYAI_API_KEY: "from-env", OTHER: "1" });
      expect(d.ensureApiKey).not.toHaveBeenCalled();
    });
  });

  test("falls back to the login key, asking for it as a LOCAL-SESSION credential", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, ".env"), "OTHER=1\n");
      const d = deps("fallback");
      const env = await resolveAgentEnv(dir, agent({ name: "a" }), createFakeUi(), d);
      expect(env.ASSEMBLYAI_API_KEY).toBe("fallback");
      expect(d.ensureApiKey).toHaveBeenCalledWith(undefined, "local-session");
    });
  });

  test("a shell-exported key skips the login, stays out of the env, and is flagged via notify", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "shell-key");
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, ".env"), "OTHER=1\n");
      const d = deps();
      const ui = createFakeUi();
      const env = await resolveAgentEnv(dir, agent({ name: "a" }), ui, d);
      expect(d.ensureApiKey).not.toHaveBeenCalled();
      expect(env).not.toHaveProperty("ASSEMBLYAI_API_KEY");
      // `notify`, so a piped (JSON-mode, silenced) `aai dev` still says it.
      ui.silence();
      await resolveAgentEnv(dir, agent({ name: "a" }), ui, d);
      expect(ui.stderr.join("\n")).toContain("resolved from your shell, not .env");
    });
  });

  test("a workflow app never asks for the login key", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, ".env"), "");
      const d = deps();
      await resolveAgentEnv(
        dir,
        { ...agent({ name: "a" }), mode: "workflow-app" },
        createFakeUi(),
        d,
      );
      expect(d.ensureApiKey).not.toHaveBeenCalled();
    });
  });
});
