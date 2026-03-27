import { describe, expect, test, vi } from "vitest";

const mockExecaFn = vi.fn();

vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExecaFn(...args),
}));

import { deploy, initProject } from "./_deploy.ts";

describe("initProject", () => {
  test("runs npx aai init with correct flags", async () => {
    mockExecaFn.mockResolvedValue({ stdout: "", stderr: "" });

    await initProject("/tmp/test-app");

    expect(mockExecaFn).toHaveBeenCalledWith(
      "npx",
      ["@alexkroman1/aai-cli", "init", "--yes", "--skipDeploy"],
      expect.objectContaining({ cwd: "/tmp/test-app", stdio: "pipe" }),
    );
  });
});

describe("deploy", () => {
  test("parses Ready URL from stdout", async () => {
    mockExecaFn.mockResolvedValue({
      stdout: "Building...\nReady: https://aai-agent.fly.dev/happy-dragon",
      stderr: "",
    });

    const url = await deploy({ workDir: "/tmp/test-app", assemblyaiApiKey: "key-123" });
    expect(url).toBe("https://aai-agent.fly.dev/happy-dragon");
  });

  test("falls back to any URL in stdout", async () => {
    mockExecaFn.mockResolvedValue({
      stdout: "Deployed to https://aai-agent.fly.dev/sunny-penguin",
      stderr: "",
    });

    const url = await deploy({ workDir: "/tmp/test-app", assemblyaiApiKey: "key-123" });
    expect(url).toBe("https://aai-agent.fly.dev/sunny-penguin");
  });

  test("throws when no URL found in stdout", async () => {
    mockExecaFn.mockResolvedValue({ stdout: "No URL here", stderr: "" });

    await expect(deploy({ workDir: "/tmp/test-app", assemblyaiApiKey: "key-123" })).rejects.toThrow(
      "could not parse URL",
    );
  });

  test("passes ASSEMBLYAI_API_KEY in env", async () => {
    mockExecaFn.mockResolvedValue({
      stdout: "Ready: https://aai-agent.fly.dev/test",
      stderr: "",
    });

    await deploy({ workDir: "/tmp/app", assemblyaiApiKey: "my-key" });

    expect(mockExecaFn).toHaveBeenCalledWith(
      "npx",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ ASSEMBLYAI_API_KEY: "my-key" }),
      }),
    );
  });
});
