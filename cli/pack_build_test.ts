// Copyright 2025 the AAI authors. MIT license.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const agentRoot = path.resolve(dir, "..");

describe("aai build from tarball", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-pack-test-"));

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("builds a simple agent without devDependencies", () => {
    // 1. Pack the package into a tarball
    const packOutput = execSync(`npm pack --pack-destination ${tmpDir}`, {
      cwd: agentRoot,
      encoding: "utf-8",
    }).trim();
    const filename = packOutput.split("\n").pop() ?? "";
    const tarball = path.join(tmpDir, filename);
    expect(fs.existsSync(tarball)).toBe(true);

    // 2. Create a minimal agent project
    const projectDir = path.join(tmpDir, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        type: "module",
        dependencies: {
          "@alexkroman1/aai": `file:${tarball}`,
          "@preact/signals": "^2.8.2",
          preact: "^10.29.0",
          tailwindcss: "^4.2.1",
        },
      }),
    );

    fs.writeFileSync(
      path.join(projectDir, "agent.ts"),
      'import { defineAgent } from "@alexkroman1/aai";\nexport default defineAgent({ name: "Test" });\n',
    );

    fs.writeFileSync(
      path.join(projectDir, "client.tsx"),
      'import "@alexkroman1/aai/ui/styles.css";\nimport { App, mount } from "@alexkroman1/aai/ui";\nmount(App);\n',
    );

    fs.writeFileSync(
      path.join(projectDir, "index.html"),
      '<!DOCTYPE html><html><head></head><body><main id="app"></main><script type="module" src="./client.tsx"></script></body></html>\n',
    );

    fs.writeFileSync(
      path.join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          jsxImportSource: "preact",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
        },
      }),
    );

    // 3. Install dependencies (production only — no devDeps)
    execSync("npm install --ignore-scripts", {
      cwd: projectDir,
      stdio: "pipe",
    });

    // 4. Run aai build via the installed CLI
    const aaiBin = path.join(projectDir, "node_modules", ".bin", "aai");
    expect(fs.existsSync(aaiBin)).toBe(true);

    // aai build uses Ink which writes to stderr, so capture both streams
    let output: string;
    try {
      output = execSync(`${aaiBin} build 2>&1`, {
        cwd: projectDir,
        encoding: "utf-8",
        env: { ...process.env, INIT_CWD: projectDir, NO_COLOR: "1" },
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      throw new Error(`aai build failed:\n${e.stderr || e.stdout || e.message}`);
    }

    // Build succeeded if we get here without throwing.
    // Ink output may not appear when piped (non-TTY), so just check exit code.
    expect(output).toBeDefined();
  }, 120_000);
});
