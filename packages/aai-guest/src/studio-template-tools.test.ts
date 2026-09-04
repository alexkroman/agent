// Copyright 2026 the AAI authors. MIT license.
// Template tools: listing the bundled templates and copying their files
// verbatim into the workspace, under the same caps the sync enforces.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDef } from "@alexkroman1/aai";
import { beforeEach, describe, expect, test } from "vitest";
import { runTool, useTempDir } from "./_test-utils.ts";
import { MAX_STUDIO_FILES } from "./limits.ts";
import { bundledTemplatesRoot, createTemplateTools } from "./studio-template-tools.ts";
import { createPostWriteDiagnostics, type TypecheckResult } from "./studio-write-diagnostics.ts";

const workspace = useTempDir("studio-template-ws-");
const templates = useTempDir("studio-templates-");
let dir: string;
let templatesRoot: string;

const AGENT_TS = `import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Pizza Ordering",
});
`;
const CLIENT_TSX = "export const x = 1;\n";

function makeTools(opts?: {
  typecheck?: () => Promise<TypecheckResult>;
  templatesRoot?: string | null;
}): Record<string, ToolDef> {
  return createTemplateTools({
    dir,
    diagnostics: createPostWriteDiagnostics(
      opts?.typecheck ?? (async () => ({ ok: true, skipped: false })),
    ),
    templatesRoot: opts?.templatesRoot !== undefined ? opts.templatesRoot : templatesRoot,
  });
}

beforeEach(async () => {
  dir = workspace();
  templatesRoot = templates();
  await mkdir(path.join(templatesRoot, "pizza", "prompts"), { recursive: true });
  await writeFile(path.join(templatesRoot, "pizza", "agent.ts"), AGENT_TS);
  await writeFile(path.join(templatesRoot, "pizza", "client.tsx"), CLIENT_TSX);
  await writeFile(path.join(templatesRoot, "pizza", "prompts", "system.md"), "be helpful\n");
  await mkdir(path.join(templatesRoot, "simple"));
  await writeFile(path.join(templatesRoot, "simple", "agent.ts"), "export default 1;\n");
});

describe("list_templates", () => {
  test("lists every template with its files and display name", async () => {
    const result = await runTool(makeTools(), "list_templates", {});
    expect(result).toContain('- pizza ("Pizza Ordering"): agent.ts, client.tsx, prompts/system.md');
    expect(result).toContain("- simple: agent.ts");
    expect(result).toContain("use_template");
  });

  test("degrades to an error when the toolchain is not resolvable", async () => {
    const result = await runTool(makeTools({ templatesRoot: null }), "list_templates", {});
    expect(result).toContain("no templates are available");
  });

  test("the default root resolves the real bundled templates", async () => {
    const root = bundledTemplatesRoot();
    expect(root).not.toBeNull();
    const tools = createTemplateTools({
      dir,
      diagnostics: createPostWriteDiagnostics(async () => ({ ok: true, skipped: false })),
    });
    const result = await runTool(tools, "list_templates", {});
    expect(result).toContain("- simple");
    expect(result).toContain("- pizza-ordering");
  });
});

describe("use_template", () => {
  test("copies every template file verbatim into the workspace", async () => {
    const result = await runTool(makeTools(), "use_template", { template: "pizza" });
    expect(result).toContain('Copied 3 file(s) from template "pizza"');
    expect(await readFile(path.join(dir, "agent.ts"), "utf-8")).toBe(AGENT_TS);
    expect(await readFile(path.join(dir, "client.tsx"), "utf-8")).toBe(CLIENT_TSX);
    expect(await readFile(path.join(dir, "prompts", "system.md"), "utf-8")).toBe("be helpful\n");
  });

  test("copies only the requested subset", async () => {
    const result = await runTool(makeTools(), "use_template", {
      template: "pizza",
      files: ["client.tsx"],
    });
    expect(result).toContain("Copied 1 file(s)");
    expect(await readFile(path.join(dir, "client.tsx"), "utf-8")).toBe(CLIENT_TSX);
    await expect(readFile(path.join(dir, "agent.ts"), "utf-8")).rejects.toThrow();
  });

  test("rejects a file the template does not have, naming its real files", async () => {
    const result = await runTool(makeTools(), "use_template", {
      template: "pizza",
      files: ["nope.ts"],
    });
    expect(result).toContain("no file nope.ts");
    expect(result).toContain("agent.ts");
  });

  // A traversal can never match a listing.
  test.each(["nope", "../pizza", "pizza/.."])(
    "rejects the unknown template %j",
    async (template) => {
      const result = await runTool(makeTools(), "use_template", { template });
      expect(result).toContain("unknown template");
    },
  );

  test("refuses to overwrite a differing workspace file without overwrite", async () => {
    await writeFile(path.join(dir, "agent.ts"), "// mine\n");
    const result = await runTool(makeTools(), "use_template", { template: "pizza" });
    expect(result).toContain("already has agent.ts");
    // The refusal wrote NOTHING — client.tsx was not copied either.
    await expect(readFile(path.join(dir, "client.tsx"), "utf-8")).rejects.toThrow();
    expect(await readFile(path.join(dir, "agent.ts"), "utf-8")).toBe("// mine\n");
  });

  test("overwrite: true replaces differing files", async () => {
    await writeFile(path.join(dir, "agent.ts"), "// mine\n");
    const result = await runTool(makeTools(), "use_template", {
      template: "pizza",
      overwrite: true,
    });
    expect(result).toContain("Copied 3 file(s)");
    expect(await readFile(path.join(dir, "agent.ts"), "utf-8")).toBe(AGENT_TS);
  });

  test("byte-identical files are reported as already present, not conflicts", async () => {
    await writeFile(path.join(dir, "agent.ts"), AGENT_TS);
    const result = await runTool(makeTools(), "use_template", { template: "pizza" });
    expect(result).toContain("Copied 2 file(s)");
    expect(result).toContain("Already present and identical: agent.ts");
  });

  test("refuses a copy that would blow the workspace file cap", async () => {
    await Promise.all(
      Array.from({ length: MAX_STUDIO_FILES }, (_, i) =>
        writeFile(path.join(dir, `f${i}.txt`), "x"),
      ),
    );
    const result = await runTool(makeTools(), "use_template", { template: "pizza" });
    expect(result).toContain(`max ${MAX_STUDIO_FILES}`);
    await expect(readFile(path.join(dir, "agent.ts"), "utf-8")).rejects.toThrow();
  });

  test("appends post-copy type diagnostics like write_file does", async () => {
    const result = await runTool(
      makeTools({ typecheck: async () => ({ ok: false, output: "agent.ts(1,1): TS0000" }) }),
      "use_template",
      { template: "simple" },
    );
    expect(result).toContain("Copied 1 file(s)");
    expect(result).toContain("Type errors after writing");
    expect(result).toContain("TS0000");
  });
});
