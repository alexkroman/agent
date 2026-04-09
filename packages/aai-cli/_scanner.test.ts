// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { extractConstExport, scanAgentDirectory } from "./_scanner.ts";
import { withTempDir } from "./_test-utils.ts";

// ---------------------------------------------------------------------------
// extractConstExport
// ---------------------------------------------------------------------------

describe("extractConstExport", () => {
  test("extracts double-quoted string", () => {
    const src = `export const description = "Look up a word";`;
    expect(extractConstExport(src, "description")).toBe("Look up a word");
  });

  test("extracts single-quoted string", () => {
    const src = `export const description = 'Look up a word';`;
    expect(extractConstExport(src, "description")).toBe("Look up a word");
  });

  test("extracts string with type annotation", () => {
    const src = `export const description: string = "typed";`;
    expect(extractConstExport(src, "description")).toBe("typed");
  });

  test("extracts JSON object literal", () => {
    const src = `export const parameters = { "query": { "type": "string" } };`;
    expect(extractConstExport(src, "parameters")).toEqual({
      query: { type: "string" },
    });
  });

  test("extracts object with unquoted keys", () => {
    const src = `export const parameters = { query: { type: "string" } };`;
    expect(extractConstExport(src, "parameters")).toEqual({
      query: { type: "string" },
    });
  });

  test("handles trailing commas", () => {
    const src = `export const parameters = { query: { type: "string", }, };`;
    expect(extractConstExport(src, "parameters")).toEqual({
      query: { type: "string" },
    });
  });

  test("extracts array literal", () => {
    const src = `export const items = ["a", "b", "c"];`;
    expect(extractConstExport(src, "items")).toEqual(["a", "b", "c"]);
  });

  test("returns undefined for missing export", () => {
    const src = `export const other = "hello";`;
    expect(extractConstExport(src, "description")).toBeUndefined();
  });

  test("returns undefined for non-export const", () => {
    const src = `const description = "not exported";`;
    expect(extractConstExport(src, "description")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// scanAgentDirectory
// ---------------------------------------------------------------------------

describe("scanAgentDirectory", () => {
  test("minimal agent (just agent.json with name)", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "minimal-agent" }));

      const manifest = await scanAgentDirectory(dir);

      expect(manifest.name).toBe("minimal-agent");
      expect(manifest.tools).toEqual({});
      expect(manifest.hooks).toEqual({
        onConnect: false,
        onDisconnect: false,
        onUserTranscript: false,
        onError: false,
      });
      // Defaults applied by parseManifest
      expect(manifest.systemPrompt).toBeDefined();
      expect(manifest.greeting).toBeDefined();
      expect(manifest.maxSteps).toBe(5);
      expect(manifest.toolChoice).toBe("auto");
    });
  });

  test("tool metadata extraction (description + parameters)", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "tool-agent" }));

      await fs.mkdir(path.join(dir, "tools"));
      await fs.writeFile(
        path.join(dir, "tools", "lookup.ts"),
        [
          'export const description = "Look up a word in the dictionary";',
          'export const parameters = { word: { type: "string" } };',
          "export async function execute({ word }: { word: string }) {",
          // eslint/biome: not a real template — this is source text written to a file
          "  return word;",
          "}",
        ].join("\n"),
      );

      const manifest = await scanAgentDirectory(dir);

      expect(manifest.tools).toEqual({
        lookup: {
          description: "Look up a word in the dictionary",
          parameters: { word: { type: "string" } },
        },
      });
    });
  });

  test("hook detection from file presence", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "hook-agent" }));

      await fs.mkdir(path.join(dir, "hooks"));
      await fs.writeFile(
        path.join(dir, "hooks", "on-connect.ts"),
        "export default function onConnect(ctx: any) { /* setup */ }",
      );
      await fs.writeFile(
        path.join(dir, "hooks", "on-error.ts"),
        "export default function onError(ctx: any, err: Error) { /* log */ }",
      );

      const manifest = await scanAgentDirectory(dir);

      expect(manifest.hooks).toEqual({
        onConnect: true,
        onDisconnect: false,
        onUserTranscript: false,
        onError: true,
      });
    });
  });

  test("hook detection ignores non-ts files", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "hook-agent" }));

      await fs.mkdir(path.join(dir, "hooks"));
      await fs.writeFile(
        path.join(dir, "hooks", "on-connect.ts"),
        "export default function onConnect() {}",
      );
      // This .md file should be ignored
      await fs.writeFile(path.join(dir, "hooks", "on-disconnect.md"), "# Not a hook");

      const manifest = await scanAgentDirectory(dir);

      expect(manifest.hooks.onConnect).toBe(true);
      expect(manifest.hooks.onDisconnect).toBe(false);
    });
  });

  test("zero-arg tools (no parameters export)", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "no-param-agent" }));

      await fs.mkdir(path.join(dir, "tools"));
      await fs.writeFile(
        path.join(dir, "tools", "ping.ts"),
        [
          'export const description = "Ping the server";',
          'export async function execute() { return "pong"; }',
        ].join("\n"),
      );

      const manifest = await scanAgentDirectory(dir);

      expect(manifest.tools).toEqual({
        ping: { description: "Ping the server" },
      });
    });
  });

  test("systemPrompt $ref resolution", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "agent.json"),
        JSON.stringify({
          name: "ref-agent",
          systemPrompt: { $ref: "system-prompt.md" },
        }),
      );
      await fs.writeFile(path.join(dir, "system-prompt.md"), "You are a helpful assistant.");

      const manifest = await scanAgentDirectory(dir);

      expect(manifest.systemPrompt).toBe("You are a helpful assistant.");
    });
  });

  test("missing agent.json throws", async () => {
    await withTempDir(async (dir) => {
      await expect(scanAgentDirectory(dir)).rejects.toThrow(/Missing agent\.json/);
    });
  });

  test("tool missing description export throws", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "bad-tool-agent" }));

      await fs.mkdir(path.join(dir, "tools"));
      await fs.writeFile(
        path.join(dir, "tools", "broken.ts"),
        [
          "// Missing description export",
          'export async function execute() { return "oops"; }',
        ].join("\n"),
      );

      await expect(scanAgentDirectory(dir)).rejects.toThrow(/must export a string "description"/);
    });
  });

  test("agent.json fields are passed through to manifest", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "agent.json"),
        JSON.stringify({
          name: "full-agent",
          systemPrompt: "Be concise.",
          greeting: "Hello!",
          sttPrompt: "technical terms",
          builtinTools: ["web_search"],
          maxSteps: 10,
          toolChoice: "required",
        }),
      );

      const manifest = await scanAgentDirectory(dir);

      expect(manifest.name).toBe("full-agent");
      expect(manifest.systemPrompt).toBe("Be concise.");
      expect(manifest.greeting).toBe("Hello!");
      expect(manifest.sttPrompt).toBe("technical terms");
      expect(manifest.builtinTools).toEqual(["web_search"]);
      expect(manifest.maxSteps).toBe(10);
      expect(manifest.toolChoice).toBe("required");
    });
  });
});
