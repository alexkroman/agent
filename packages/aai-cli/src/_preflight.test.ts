// Copyright 2026 the AAI authors. MIT license.
// The credential preflight moved here from the platform's deploy boundary
// when the server stopped extracting (and storing) agent configs; these
// specs came with it, minus the reject/warn policy the server owned.
import { describe, expect, test } from "vitest";
import {
  CARRIER_SIGNING_SECRETS,
  declaredCarriers,
  missingCredentialMessage,
  missingCredentials,
  missingTelephonySecrets,
  missingTelephonySecretWarnings,
  type PreflightConfig,
  requiredEnvNames,
  telephonyWebhooks,
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

describe("requiredEnvNames", () => {
  // The derivation `missingDeployEnv` was NOT using: a `--target` build read
  // `.env.example` alone, so a key declared only here got neither a warning
  // nor an `env add` step. Pinned as its own function because two callers now
  // share it and the second one is what the docs already promised.
  test("unions the provider credentials with the agent's own requiredEnv", () => {
    const names = requiredEnvNames({ ...PIPELINE_AGENT, requiredEnv: ["ORDERS_API_KEY"] });
    expect(names).toContain("ASSEMBLYAI_API_KEY");
    expect(names).toContain("ANTHROPIC_API_KEY");
    expect(names).toContain("CARTESIA_API_KEY");
    expect(names).toContain("ORDERS_API_KEY");
  });

  test("names a requiredEnv key with no provider credential beside it", () => {
    // The `--target` case exactly: an agent whose only declaration is a custom
    // key its tools read, on a front door that dials no provider.
    expect(requiredEnvNames({ page: "static", requiredEnv: ["ORDERS_API_KEY"] })).toEqual([
      "ORDERS_API_KEY",
    ]);
  });

  test("de-duplicates a name that is both a provider key and requiredEnv", () => {
    expect(requiredEnvNames({ requiredEnv: ["ASSEMBLYAI_API_KEY"] })).toEqual([
      "ASSEMBLYAI_API_KEY",
    ]);
  });
});

describe("declaredCarriers", () => {
  test.each([
    ["absent", undefined, []],
    ["false", false, []],
    ["an empty list", [], []],
    ["one carrier", ["telnyx"], ["telnyx"]],
    ["true", true, ["twilio", "telnyx"]],
  ])("resolves %s", (_label, telephony, expected) => {
    expect(declaredCarriers({ telephony: telephony as PreflightConfig["telephony"] })).toEqual(
      expected,
    );
  });

  test("drops a carrier this build ships no codec for", () => {
    // A stored config may have been written by a newer SDK. Dropping serves the
    // carriers we know; refusing the lot would take a working number down.
    const config = { telephony: ["twilio", "vonage"] } as unknown as PreflightConfig;
    expect(declaredCarriers(config)).toEqual(["twilio"]);
  });
});

describe("missingTelephonySecrets", () => {
  test("names the signing secret of a declared carrier the env has no value for", () => {
    // The bug this exists for: signature checking is enabled BY PRESENCE, so a
    // Telnyx agent with no TELNYX_PUBLIC_KEY deploys, connects, and verifies
    // nothing — with no line anywhere saying so.
    expect(missingTelephonySecrets({ telephony: ["telnyx"] }, {})).toEqual([
      { carrier: "telnyx", secret: "TELNYX_PUBLIC_KEY" },
    ]);
  });

  test("says nothing about a carrier the agent did not declare", () => {
    expect(missingTelephonySecrets({ telephony: ["twilio"] }, {})).toEqual([
      { carrier: "twilio", secret: "TWILIO_AUTH_TOKEN" },
    ]);
  });

  test("is empty for an agent that declares no telephony at all", () => {
    // Every voice agent that has no phone number: this must add no noise.
    expect(missingTelephonySecrets(PIPELINE_AGENT, {})).toEqual([]);
  });

  test("is empty once every declared carrier's secret is set", () => {
    expect(
      missingTelephonySecrets(
        { telephony: true },
        { TWILIO_AUTH_TOKEN: "t", TELNYX_PUBLIC_KEY: "p" },
      ),
    ).toEqual([]);
  });

  test("an empty-string secret counts as missing", () => {
    // `verifyPhoneWebhook` reads the stored value: a blank secret is a check
    // that cannot pass, not a check that is off.
    expect(missingTelephonySecrets({ telephony: ["twilio"] }, { TWILIO_AUTH_TOKEN: "" })).toEqual([
      { carrier: "twilio", secret: "TWILIO_AUTH_TOKEN" },
    ]);
  });

  test("names a secret for every carrier the vocabulary has", () => {
    // The copy of `phone-signature.ts`'s constants is kept total by
    // `satisfies`; this is the runtime half — a carrier with no secret named
    // would silently never be warned about.
    expect(Object.values(CARRIER_SIGNING_SECRETS).every((name) => name.length > 0)).toBe(true);
    expect(declaredCarriers({ telephony: true }).map((c) => CARRIER_SIGNING_SECRETS[c])).toEqual([
      "TWILIO_AUTH_TOKEN",
      "TELNYX_PUBLIC_KEY",
    ]);
  });
});

describe("missingTelephonySecretWarnings", () => {
  test("names the carrier, the secret, and what being unset means", () => {
    const [warning] = missingTelephonySecretWarnings([
      { carrier: "telnyx", secret: "TELNYX_PUBLIC_KEY" },
    ]);
    expect(warning).toContain("telnyx");
    expect(warning).toContain("TELNYX_PUBLIC_KEY");
    // The consequence, not just the absence — the absence is invisible at every
    // other layer, so the warning is the only thing that can say what it costs.
    expect(warning).toContain("OFF");
    // Same posture as the credential message: the CLI cannot see what the
    // platform already holds, so it must not assert the secret is absent there.
    expect(warning).toContain("aai secret put");
  });

  test("one sentence per carrier", () => {
    expect(
      missingTelephonySecretWarnings([
        { carrier: "twilio", secret: "TWILIO_AUTH_TOKEN" },
        { carrier: "telnyx", secret: "TELNYX_PUBLIC_KEY" },
      ]),
    ).toHaveLength(2);
  });
});

describe("telephonyWebhooks", () => {
  test("fills in the carrier parameter for every declared carrier", () => {
    // The whole point: the platform's phone route defaults `carrier` to twilio
    // and never reads the declaration, so a Telnyx number configured without
    // the parameter answers 403 on the signature rather than on the mistake.
    expect(telephonyWebhooks({ telephony: true }, "https://srv/agent")).toEqual([
      { carrier: "twilio", url: "https://srv/agent/phone?carrier=twilio" },
      { carrier: "telnyx", url: "https://srv/agent/phone?carrier=telnyx" },
    ]);
  });

  test("is empty for an agent that declares no carrier", () => {
    expect(telephonyWebhooks(PIPELINE_AGENT, "https://srv/agent")).toEqual([]);
  });
});
