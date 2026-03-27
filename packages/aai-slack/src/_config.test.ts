import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "./_config.ts";

const REQUIRED_VARS = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  ASSEMBLYAI_API_KEY: "test-key",
};

function setEnv(overrides?: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(REQUIRED_VARS)) {
    process.env[k] = v;
  }
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

afterEach(() => {
  for (const k of Object.keys(REQUIRED_VARS)) {
    delete process.env[k];
  }
  delete process.env.AAI_SERVER_URL;
  delete process.env.EXAMPLES_REPO_PATH;
});

describe("loadConfig", () => {
  test("loads all required env vars", () => {
    setEnv();
    const config = loadConfig();
    expect(config.slackBotToken).toBe("xoxb-test");
    expect(config.slackAppToken).toBe("xapp-test");
    expect(config.anthropicApiKey).toBe("sk-ant-test");
    expect(config.assemblyaiApiKey).toBe("test-key");
  });

  test("uses default serverUrl when not set", () => {
    setEnv();
    const config = loadConfig();
    expect(config.serverUrl).toBe("https://aai-agent.fly.dev");
  });

  test("uses custom serverUrl when set", () => {
    setEnv({ AAI_SERVER_URL: "https://custom.example.com" });
    const config = loadConfig();
    expect(config.serverUrl).toBe("https://custom.example.com");
  });

  test("uses custom examplesRepoPath when set", () => {
    setEnv({ EXAMPLES_REPO_PATH: "/tmp/my-examples" });
    const config = loadConfig();
    expect(config.examplesRepoPath).toBe("/tmp/my-examples");
  });

  test("throws when SLACK_BOT_TOKEN is missing", () => {
    setEnv({ SLACK_BOT_TOKEN: undefined });
    expect(() => loadConfig()).toThrow("Missing required env var: SLACK_BOT_TOKEN");
  });

  test("throws when SLACK_APP_TOKEN is missing", () => {
    setEnv({ SLACK_APP_TOKEN: undefined });
    expect(() => loadConfig()).toThrow("Missing required env var: SLACK_APP_TOKEN");
  });

  test("throws when ANTHROPIC_API_KEY is missing", () => {
    setEnv({ ANTHROPIC_API_KEY: undefined });
    expect(() => loadConfig()).toThrow("Missing required env var: ANTHROPIC_API_KEY");
  });

  test("throws when ASSEMBLYAI_API_KEY is missing", () => {
    setEnv({ ASSEMBLYAI_API_KEY: undefined });
    expect(() => loadConfig()).toThrow("Missing required env var: ASSEMBLYAI_API_KEY");
  });
});
