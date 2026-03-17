import { describe, expect, test } from "vitest";
import { rootHelp, subcommandHelp } from "./_help.ts";

describe("rootHelp", () => {
  const version = "1.2.3";
  const output = rootHelp(version);

  test("includes version string", () => {
    expect(output).toContain(version);
  });

  test("includes command names", () => {
    expect(output).toContain("new");
    expect(output).toContain("deploy");
    expect(output).toContain("env");
    expect(output).toContain("rag");
  });

  test('includes "Voice agent development kit"', () => {
    expect(output).toContain("Voice agent development kit");
  });
});

describe("subcommandHelp", () => {
  const version = "2.0.0";

  test("includes command name", () => {
    const output = subcommandHelp({ name: "deploy", description: "Deploy agent" }, version);
    expect(output).toContain("deploy");
  });

  test("includes command description", () => {
    const output = subcommandHelp({ name: "deploy", description: "Deploy agent" }, version);
    expect(output).toContain("Deploy agent");
  });

  test("includes version", () => {
    const output = subcommandHelp({ name: "deploy", description: "Deploy agent" }, version);
    expect(output).toContain(version);
  });

  test("renders arguments", () => {
    const output = subcommandHelp(
      {
        name: "new",
        description: "Create a new agent",
        args: [{ name: "dir", optional: true }],
      },
      version,
    );
    expect(output).toContain("Arguments");
    expect(output).toContain("dir");
  });

  test("renders visible options", () => {
    const output = subcommandHelp(
      {
        name: "deploy",
        description: "Deploy agent",
        options: [{ flags: "-y, --yes", description: "Skip prompts" }],
      },
      version,
    );
    expect(output).toContain("Options");
    expect(output).toContain("-y, --yes");
    expect(output).toContain("Skip prompts");
  });

  test("hides options with hidden: true", () => {
    const output = subcommandHelp(
      {
        name: "deploy",
        description: "Deploy agent",
        options: [
          { flags: "-y, --yes", description: "Skip prompts" },
          { flags: "--secret", description: "Secret option", hidden: true },
        ],
      },
      version,
    );
    expect(output).toContain("-y, --yes");
    expect(output).not.toContain("--secret");
    expect(output).not.toContain("Secret option");
  });
});
