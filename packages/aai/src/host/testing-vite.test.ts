// Copyright 2026 the AAI authors. MIT license.
/**
 * The plugin's whole job is to emit a module an author never reads, so what a
 * spec can check is the SOURCE it emits — the imports, the tool map, and the two
 * keys it omits rather than passes empty.
 *
 * It builds real directories under `tmpdir()` for the same reason
 * `workspace-files.test.ts` does: the module's inputs ARE a directory listing,
 * and a `node:fs` mock would test the mock's idea of one.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AAI_AGENT_MODULE, aaiAgentPlugin } from "./testing-vite.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

/** An agent project on disk: `agent.ts` plus whatever else the case needs. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aai-testing-vite-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  }
  return dir;
}

/**
 * The emitted source for a project, through both hooks the way Vite calls them.
 *
 * It THROWS rather than asserting: an `expect` in a helper is
 * `noMisplacedAssertion`, and a decline here is a broken harness rather than a
 * finding about the plugin.
 */
function emit(dir: string): string {
  const plugin = aaiAgentPlugin();
  const id = plugin.resolveId(AAI_AGENT_MODULE, join(dir, "agent.test.ts"));
  if (id === undefined) throw new Error("resolveId declined its own specifier");
  const source = plugin.load(id);
  if (source === undefined) throw new Error(`load declined the id it resolved: ${id}`);
  return source;
}

describe("resolveId", () => {
  test("claims only its own specifier", () => {
    const plugin = aaiAgentPlugin();
    expect(plugin.resolveId("./agent.ts", "/a/b/agent.test.ts")).toBeUndefined();
    expect(plugin.resolveId("virtual:aai/other", "/a/b/agent.test.ts")).toBeUndefined();
  });

  test("resolves against the IMPORTER's directory, not the process cwd", () => {
    const plugin = aaiAgentPlugin();
    expect(plugin.resolveId(AAI_AGENT_MODULE, "/agents/billing/agent.test.ts")).toBe(
      "\0aai-agent:/agents/billing",
    );
  });

  test("refuses a request with no importer, naming the reason", () => {
    const plugin = aaiAgentPlugin();
    expect(() => plugin.resolveId(AAI_AGENT_MODULE)).toThrow(/no importer/);
  });
});

describe("load", () => {
  test("ignores an id it did not resolve", () => {
    expect(aaiAgentPlugin().load("/agents/billing/agent.ts")).toBeUndefined();
  });

  test("names the directory it looked in when there is no agent.ts", async () => {
    const dir = await project({ "agent.test.ts": "" });
    expect(() => emit(dir)).toThrow(new RegExp(`no agent\\.ts in ${dir}`));
  });

  test("imports the agent, every tool, and the prompt", async () => {
    const dir = await project({
      "agent.ts": "export default {};",
      "system-prompt.md": "Be brief.",
      "tools/lookup.ts": "export const x = 1;",
      "tools/charge.ts": "export const x = 1;",
    });
    const source = emit(dir);

    expect(source).toContain('import { deployedAgent } from "@alexkroman1/aai/testing";');
    expect(source).toContain(JSON.stringify(join(dir, "agent.ts")));
    expect(source).toContain(JSON.stringify(`${join(dir, "system-prompt.md")}?raw`));
    expect(source).toContain("  tools,");
    expect(source).toContain("  systemPrompt,");
    // Sorted, so the emitted module is stable across filesystems that list in
    // creation order — `charge` was written second.
    expect(source.indexOf("charge.ts")).toBeLessThan(source.indexOf("lookup.ts"));
    expect(source).toContain(
      `import * as tool0 from ${JSON.stringify(join(dir, "tools/charge.ts"))};`,
    );
    expect(source).toContain(`[${JSON.stringify(join(dir, "tools/charge.ts"))}]: tool0,`);
  });

  test("a tool directory holds tools — specs and type tests are not among them", async () => {
    const dir = await project({
      "agent.ts": "export default {};",
      "tools/lookup.ts": "export const x = 1;",
      "tools/lookup.test.ts": "export const x = 1;",
      "tools/lookup.test-d.ts": "export const x = 1;",
      "tools/README.md": "not a tool",
    });
    const source = emit(dir);

    expect(source).toContain("lookup.ts");
    expect(source).not.toContain("lookup.test.ts");
    expect(source).not.toContain("lookup.test-d.ts");
    expect(source).not.toContain("README.md");
    expect(source).not.toContain("tool1");
  });

  test("omits `tools` rather than passing an empty one", async () => {
    const dir = await project({ "agent.ts": "export default {};" });
    const source = emit(dir);

    expect(source).not.toContain("  tools,");
    expect(source).not.toContain("  systemPrompt,");
    expect(source).toContain("export default deployedAgent(authored, {\n});");
  });

  test("an empty tools/ directory is a fact, not a broken glob", async () => {
    const dir = await project({ "agent.ts": "export default {};" });
    await mkdir(join(dir, "tools"));
    expect(emit(dir)).not.toContain("  tools,");
  });

  test("a prompt with no tools still reaches the call", async () => {
    const dir = await project({
      "agent.ts": "export default {};",
      "system-prompt.md": "Be brief.",
    });
    const source = emit(dir);

    expect(source).not.toContain("  tools,");
    expect(source).toContain("  systemPrompt,");
  });
});
