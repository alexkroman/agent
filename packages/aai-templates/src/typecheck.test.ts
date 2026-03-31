import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import {
  NodeFileSystem,
  allowAllFs,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";
import { createTypeScriptTools } from "@secure-exec/typescript";

const require = createRequire(import.meta.url);
const compilerSpecifier = require.resolve("typescript/lib/typescript.js");

const cwd = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

describe("template typecheck", () => {
  test("all templates typecheck via @secure-exec/typescript", async () => {
    const ts = createTypeScriptTools({
      systemDriver: createNodeDriver({
        filesystem: new NodeFileSystem(),
        permissions: { ...allowAllFs },
      }),
      runtimeDriverFactory: createNodeRuntimeDriverFactory(),
      compilerSpecifier,
    });

    const result = await ts.typecheckProject({
      cwd,
      configFilePath: `${cwd}/tsconfig.json`,
    });

    if (!result.success) {
      const messages = result.diagnostics.map((d) => {
        const loc = d.filePath ? `${d.filePath}${d.line != null ? `:${d.line}` : ""}` : "";
        return `${loc} - error TS${d.code}: ${d.message}`;
      });
      expect.fail(`Typecheck failed:\n${messages.join("\n")}`);
    }
  }, 30_000);
});
