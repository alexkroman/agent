// Copyright 2026 the AAI authors. MIT license.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  layerScaffoldFiles,
  mergeScaffoldManifest,
  PROJECT_GUIDE_POINTER,
  readScaffoldFiles,
} from "./scaffold-layer.ts";

/** A studio workspace exactly as the guest writes one (`project-shape.ts`). */
const STUDIO_MANIFEST = `${JSON.stringify(
  { name: "aai-studio-workspace", private: true, type: "module", dependencies: {} },
  null,
  2,
)}\n`;

const SCAFFOLD: Record<string, string> = {
  "package.json": JSON.stringify({
    type: "module",
    scripts: { dev: "aai dev", test: "aai test" },
    dependencies: { "@alexkroman1/aai": "^17.0.0", "@alexkroman1/aai-cli": "^17.0.0" },
    devDependencies: { vite: "^8.2.2" },
  }),
  ".gitignore": "node_modules/\n.aai/\n",
  ".env.example": "ASSEMBLYAI_API_KEY=\n",
  "tsconfig.json": '{"compilerOptions":{"strict":true}}',
  "CLAUDE.md": "# Writing an aai agent\n\nThe whole SDK reference.\n",
};

describe("layerScaffoldFiles", () => {
  test("completes a studio workspace into a project a laptop can install and run", () => {
    // The regression: a GitHub-synced repository carried the workspace's stub
    // manifest verbatim, so `pnpm install` installed nothing and `pnpm dev`
    // was "Command not found".
    const writes = layerScaffoldFiles(
      { "agent.ts": "export default {};", "package.json": STUDIO_MANIFEST },
      SCAFFOLD,
    );
    const pkg = JSON.parse(writes["package.json"] ?? "{}");
    expect(pkg.name).toBe("aai-studio-workspace");
    expect(pkg.scripts).toEqual({ dev: "aai dev", test: "aai test" });
    expect(pkg.dependencies["@alexkroman1/aai-cli"]).toBe("^17.0.0");
    expect(pkg.devDependencies.vite).toBe("^8.2.2");
    expect(writes[".gitignore"]).toBe(SCAFFOLD[".gitignore"]);
    expect(writes[".env.example"]).toBe(SCAFFOLD[".env.example"]);
  });

  test("returns only what changes — the project's own files always win", () => {
    const writes = layerScaffoldFiles(
      { "agent.ts": "x", "tsconfig.json": "{}", ".gitignore": "mine\n" },
      SCAFFOLD,
    );
    expect(writes["agent.ts"]).toBeUndefined();
    expect(writes["tsconfig.json"]).toBeUndefined();
    expect(writes[".gitignore"]).toBeUndefined();
    expect(Object.keys(writes).sort()).toEqual([".env.example", "CLAUDE.md", "package.json"]);
  });

  test("a complete manifest is not rewritten", () => {
    const writes = layerScaffoldFiles({ "package.json": SCAFFOLD["package.json"] ?? "" }, SCAFFOLD);
    expect(writes["package.json"]).toBeUndefined();
  });

  test("an unparseable manifest is left for the package manager to report", () => {
    const writes = layerScaffoldFiles({ "package.json": "{ not json" }, SCAFFOLD);
    expect(writes["package.json"]).toBeUndefined();
  });

  test("the guide is pointed at, never copied, and a project's own CLAUDE.md wins", () => {
    const fresh = layerScaffoldFiles({}, SCAFFOLD);
    expect(fresh["CLAUDE.md"]).toBe(PROJECT_GUIDE_POINTER);
    expect(fresh["CLAUDE.md"]).not.toContain("The whole SDK reference.");
    expect(layerScaffoldFiles({ "CLAUDE.md": "# mine\n" }, SCAFFOLD)["CLAUDE.md"]).toBeUndefined();
  });

  test("the pointer names the SDK copy in a fence, so it is mentioned rather than imported", () => {
    expect(PROJECT_GUIDE_POINTER).toContain(
      "```text\nnode_modules/@alexkroman1/aai/AGENT_GUIDE.md\n```",
    );
    expect(PROJECT_GUIDE_POINTER.split("\n").length).toBeLessThan(200);
  });

  test("no scaffold, nothing added — not even a lone CLAUDE.md", () => {
    expect(layerScaffoldFiles({ "agent.ts": "x" }, {})).toEqual({});
  });
});

describe("mergeScaffoldManifest", () => {
  test("fills top-level fields the manifest lacks, and keeps the ones it has", () => {
    const merged = mergeScaffoldManifest(
      { type: "module", name: "mine" },
      { type: "commonjs", engines: { node: ">=24" }, packageManager: "pnpm@10" },
    );
    expect(merged).toEqual({
      type: "module",
      name: "mine",
      engines: { node: ">=24" },
      packageManager: "pnpm@10",
    });
  });

  test("merges dependency maps per ENTRY, so declared pins survive", () => {
    // A pulled studio workspace can pin exact installed versions; the
    // scaffold's caret ranges must not clobber them.
    const merged = mergeScaffoldManifest(
      { dependencies: { "@alexkroman1/aai": "5.7.1" } },
      { dependencies: { "@alexkroman1/aai": "^5.7.0", zod: "^4.4.3" } },
    );
    expect(merged?.dependencies).toEqual({ "@alexkroman1/aai": "5.7.1", zod: "^4.4.3" });
  });

  test("one agent-added devDependency does not shadow the whole toolchain block", () => {
    const merged = mergeScaffoldManifest(
      { devDependencies: { "some-tool": "^1.0.0" } },
      { devDependencies: { vite: "^8.1.5", "@vitejs/plugin-react": "^6.0.4" } },
    );
    expect(merged?.devDependencies).toEqual({
      "some-tool": "^1.0.0",
      vite: "^8.1.5",
      "@vitejs/plugin-react": "^6.0.4",
    });
  });

  test("nothing missing → null, so no file is rewritten", () => {
    expect(mergeScaffoldManifest({ type: "module" }, { type: "commonjs" })).toBeNull();
    expect(
      mergeScaffoldManifest({ dependencies: { zod: "1" } }, { dependencies: { zod: "^4" } }),
    ).toBeNull();
  });
});

describe("readScaffoldFiles", () => {
  test("a missing scaffold is an empty map, not a throw", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    expect(await readScaffoldFiles(path.join(here, "no-such-scaffold-dir"))).toEqual({});
  });
});
