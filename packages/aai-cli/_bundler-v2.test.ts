// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { bundleAgentV2 } from "./_bundler-v2.ts";
import { withTempDir } from "./_test-utils.ts";

describe("bundleAgentV2", () => {
  test("produces manifest.json in output for minimal agent", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "minimal-agent" }));

      const output = await bundleAgentV2(dir);

      expect(output.manifest.name).toBe("minimal-agent");
      expect(output.manifestJson).toBe(JSON.stringify(output.manifest));
      expect(output.toolBundles).toEqual({});
      expect(output.hookBundles).toEqual({});
    });
  });

  test("compiles tool handlers to JS", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "tool-agent" }));

      await fs.mkdir(path.join(dir, "tools"));
      await fs.writeFile(
        path.join(dir, "tools", "lookup.ts"),
        [
          'export const description = "Look up a word";',
          'export const parameters = { word: { type: "string" } };',
          "export async function execute({ word }: { word: string }) {",
          '  return "Found: " + word;',
          "}",
        ].join("\n"),
      );

      const output = await bundleAgentV2(dir);

      expect(output.toolBundles).toHaveProperty("lookup");
      // Compiled JS should contain the execute function
      expect(output.toolBundles.lookup).toContain("execute");
      // TypeScript type annotations should be stripped
      expect(output.toolBundles.lookup).not.toContain("{ word: string }");
    });
  });

  test("compiles hook handlers to JS", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "hook-agent" }));

      await fs.mkdir(path.join(dir, "hooks"));
      await fs.writeFile(
        path.join(dir, "hooks", "on-connect.ts"),
        "export default function onConnect(ctx: any) { console.log('connected'); }",
      );
      await fs.writeFile(
        path.join(dir, "hooks", "on-error.ts"),
        "export default function onError(ctx: any, err: Error) { console.error(err); }",
      );

      const output = await bundleAgentV2(dir);

      expect(output.hookBundles).toHaveProperty("onConnect");
      expect(output.hookBundles).toHaveProperty("onError");
      expect(output.hookBundles).not.toHaveProperty("onDisconnect");
      expect(output.hookBundles).not.toHaveProperty("onUserTranscript");
      // Compiled JS should contain the handler code
      expect(output.hookBundles.onConnect).toContain("connected");
      expect(output.hookBundles.onError).toContain("onError");
    });
  });

  test("output contains no Zod references", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.json"), JSON.stringify({ name: "no-zod-agent" }));

      await fs.mkdir(path.join(dir, "tools"));
      await fs.writeFile(
        path.join(dir, "tools", "greet.ts"),
        [
          'export const description = "Greet someone";',
          'export const parameters = { name: { type: "string" } };',
          "export async function execute({ name }: { name: string }) {",
          '  return "Hello, " + name + "!";',
          "}",
        ].join("\n"),
      );

      const output = await bundleAgentV2(dir);

      // The manifest is produced from scanAgentDirectory which uses Zod
      // internally, but the compiled tool/hook bundles should not contain Zod
      for (const [, js] of Object.entries(output.toolBundles)) {
        expect(js).not.toContain('from "zod"');
        expect(js).not.toContain("from 'zod'");
        expect(js).not.toContain("z.string");
        expect(js).not.toContain("z.object");
      }
    });
  });

  test("tool with no parameters compiles fine", async () => {
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

      const output = await bundleAgentV2(dir);

      expect(output.toolBundles).toHaveProperty("ping");
      expect(output.toolBundles.ping).toContain("pong");
      // Manifest should have the tool without parameters
      expect(output.manifest.tools.ping).toEqual({
        description: "Ping the server",
      });
    });
  });
});
