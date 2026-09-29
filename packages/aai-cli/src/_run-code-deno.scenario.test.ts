// Copyright 2026 the AAI authors. MIT license.
/**
 * The zero-permission Deno executor against a REAL `deno`: what the model's
 * code can and cannot do once it is actually running.
 *
 * Scenario tier because it spawns a subprocess. The unit spec beside it pins
 * the argv and env; only the binary can say that argv really denies what the
 * module doc claims — including the local-module import that no permission
 * flag covers, which is the case the import map exists for.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunCodeExecutor } from "@alexkroman1/aai-runtime";
import { expect, onTestFinished, test } from "vitest";
import { resolveDenoRunCode } from "./_run-code-deno.ts";
import { type BinaryGate, describeWithBinary } from "./_test-utils.ts";

const DENO: BinaryGate = {
  bin: "deno",
  requireEnv: "AAI_REQUIRE_DENO",
  minVersion: "2.0.0",
  howTo:
    "Install Deno (`brew install deno`, or `curl -fsSL https://deno.land/install.sh | sh`).\n" +
    "CI's integration-and-scenario job pins one via denoland/setup-deno.",
};

describeWithBinary(DENO, "run_code in a zero-permission deno", () => {
  // Resolved the way `aai dev` resolves it — PATH lookup and version probe
  // included — so a resolver that stopped finding the binary fails here.
  const quiet = () => undefined;
  const silent = { info: quiet, warn: quiet, error: quiet, debug: quiet };
  const run: RunCodeExecutor = async (code) => {
    const executor = resolveDenoRunCode(silent, { AAI_RUN_CODE: "deno", PATH: process.env.PATH });
    if (executor === undefined) throw new Error("deno is on PATH but did not resolve");
    return await executor(code);
  };

  test("runs the code and answers what it printed", async () => {
    expect(await run("console.log(1+1)")).toBe("2");
  });

  test.each([
    ["the network", 'await fetch("https://example.com")', /NotCapable|PermissionDenied/],
    ["a file", 'await Deno.readTextFile("/etc/hosts")', /NotCapable|PermissionDenied/],
    ["the env", 'console.log(Deno.env.get("HOME"))', /NotCapable|PermissionDenied/],
    ["a subprocess", 'new Deno.Command("/bin/ls").outputSync()', /NotCapable|PermissionDenied/],
    ["a remote module", 'await import("https://example.com/x.js")', /import access|remote/i],
  ])("cannot reach %s", async (_what, code, refused) => {
    expect(await run(code)).toEqual({ error: expect.stringMatching(refused) });
  });

  test("cannot import a local file, which no permission flag covers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aai-run-code-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const secret = path.join(dir, "secret.json");
    await writeFile(secret, JSON.stringify({ token: "do-not-print" }));
    for (const code of [
      `import s from ${JSON.stringify(secret)} with { type: "json" }; console.log(s)`,
      `console.log(await import(${JSON.stringify(`file://${secret}`)}, { with: { type: "json" } }))`,
    ]) {
      const result = await run(code);
      expect.soft(JSON.stringify(result)).not.toContain("do-not-print");
      expect.soft(result).toEqual({ error: expect.any(String) });
    }
  });

  test("an endless loop is stopped at the deadline", async () => {
    const started = performance.now();
    expect(await run("while(true){}")).toEqual({ error: "run_code timed out after 5000ms" });
    expect(performance.now() - started).toBeLessThan(6500);
  });
});
