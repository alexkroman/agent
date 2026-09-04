// Copyright 2026 the AAI authors. MIT license.
// The credential preflight moved here from the platform's deploy boundary
// when the server stopped extracting (and storing) agent configs; these
// specs came with it, minus the reject/warn policy the server owned.
import { describe, expect, test } from "vitest";
import {
  missingCredentialMessage,
  missingCredentials,
  type PreflightConfig,
} from "./_preflight.ts";

const S2S_AGENT: PreflightConfig = {};

const PIPELINE_AGENT: PreflightConfig = {
  stt: { kind: "assemblyai", options: {} },
  llm: { kind: "anthropic", options: { model: "claude-sonnet-4-5" } },
  tts: { kind: "cartesia", options: {} },
};

describe("missingCredentials", () => {
  test("names the AssemblyAI key an S2S agent has no value for", () => {
    expect(missingCredentials(S2S_AGENT, {})).toContain("ASSEMBLYAI_API_KEY");
  });

  test("names every missing provider key of a pipeline agent", () => {
    const missing = missingCredentials(PIPELINE_AGENT, { ASSEMBLYAI_API_KEY: "k" });
    expect(missing).toContain("ANTHROPIC_API_KEY");
    expect(missing).toContain("CARTESIA_API_KEY");
    expect(missing).not.toContain("ASSEMBLYAI_API_KEY");
  });

  test("is empty once every provider key is present", () => {
    expect(
      missingCredentials(PIPELINE_AGENT, {
        ASSEMBLYAI_API_KEY: "a",
        ANTHROPIC_API_KEY: "b",
        CARTESIA_API_KEY: "c",
      }),
    ).toEqual([]);
  });

  test("blocks no deploy of a workflow app over a provider key it never dials", () => {
    // The config read here is `__aaiConfig`, i.e. post-`defaultProviders`, so a
    // static agent that declared nothing arrives carrying the whole injected
    // AssemblyAI triple. Its front door is a form; the deploy must not demand a
    // credential for a session that cannot be opened.
    const workflowApp: PreflightConfig = { page: "static", ...PIPELINE_AGENT };
    expect(missingCredentials(workflowApp, {})).toEqual([]);
  });

  test("still names a workflow app's own requiredEnv keys", () => {
    const workflowApp: PreflightConfig = { page: "static", requiredEnv: ["STRIPE_KEY"] };
    expect(missingCredentials(workflowApp, {})).toEqual(["STRIPE_KEY"]);
  });

  test("an empty-string credential counts as missing", () => {
    // An empty credential authenticates nothing, so it must not read as set.
    expect(missingCredentials(S2S_AGENT, { ASSEMBLYAI_API_KEY: "" })).toContain(
      "ASSEMBLYAI_API_KEY",
    );
  });

  test("includes the agent's declared requiredEnv keys", () => {
    // No static derivation can see a key a tool reads from ctx.env, so the
    // agent declares it and the preflight trusts the declaration.
    const missing = missingCredentials(
      { ...S2S_AGENT, requiredEnv: ["STRIPE_KEY"] },
      { ASSEMBLYAI_API_KEY: "k" },
    );
    expect(missing).toEqual(["STRIPE_KEY"]);
  });
});

describe("missingCredentialMessage", () => {
  test("reads singular for one key and plural for several", () => {
    expect(missingCredentialMessage(["A_KEY"])).toContain("Missing credential the agent needs");
    const many = missingCredentialMessage(["A_KEY", "B_KEY"]);
    expect(many).toContain("Missing credentials the agent needs");
    expect(many).toContain("A_KEY, B_KEY");
  });

  test("points at both places a key can legitimately live", () => {
    // The CLI cannot see secrets already stored against the slug, so the
    // message must not assert the key is absent from the platform too.
    const message = missingCredentialMessage(["A_KEY"]);
    expect(message).toContain(".env");
    expect(message).toContain("aai secret put");
  });
});
