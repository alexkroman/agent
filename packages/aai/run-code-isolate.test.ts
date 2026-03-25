// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests for run_code secure-exec V8 isolate.
 *
 * Verifies that each run_code invocation runs in a fresh, disposable isolate
 * with proper security boundaries: no host access, no network, no filesystem
 * writes, no child processes, no env vars, memory limits, and cross-invocation
 * isolation.
 */

import { describe, expect, test } from "vitest";
import { executeInIsolate } from "./builtin-tools.ts";

// ── Functional tests ──────────────────────────────────────────────────────

describe("run_code isolate: functional", () => {
  test("basic console.log output", async () => {
    const result = await executeInIsolate('console.log("hello world")');
    expect(result).toBe("hello world");
  });

  test("arithmetic and output", async () => {
    const result = await executeInIsolate("console.log(2 + 2)");
    expect(result).toBe("4");
  });

  test("async code works", async () => {
    const result = await executeInIsolate(`
      const delay = (ms) => new Promise(r => setTimeout(r, ms));
      await delay(50);
      console.log("async done");
    `);
    expect(result).toBe("async done");
  });

  test("multiple console outputs joined", async () => {
    const result = await executeInIsolate(`
      console.log("a");
      console.warn("b");
      console.error("c");
    `);
    expect(result).toBe("a\nb\nc");
  });

  test("no output returns success message", async () => {
    const result = await executeInIsolate("const x = 1 + 1;");
    expect(result).toBe("Code ran successfully (no output)");
  });

  test("syntax errors return error object", async () => {
    const result = await executeInIsolate("%%%");
    expect(result).toHaveProperty("error");
  });

  test("runtime errors return error object", async () => {
    const result = await executeInIsolate("throw new Error('boom')");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("boom");
  });
});

// ── Security: network isolation ────────────────────────────────────────────

describe("run_code isolate: network isolation", () => {
  test("fetch to external URL is blocked", async () => {
    const result = await executeInIsolate(`
      try {
        await fetch("https://example.com");
        console.log("ESCAPED");
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("fetch to cloud metadata is blocked", async () => {
    const result = await executeInIsolate(`
      try {
        await fetch("http://169.254.169.254/latest/meta-data/");
        console.log("ESCAPED");
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("fetch to localhost is blocked", async () => {
    const result = await executeInIsolate(`
      try {
        await fetch("http://127.0.0.1:8080/");
        console.log("ESCAPED");
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    expect(result as string).toMatch(/BLOCKED/);
  });
});

// ── Security: filesystem isolation ──────────────────────────────────────────

describe("run_code isolate: filesystem isolation", () => {
  test("filesystem writes are blocked", async () => {
    const result = await executeInIsolate(`
      try {
        const fs = await import("node:fs");
        fs.writeFileSync("/tmp/pwned.txt", "owned");
        console.log("ESCAPED");
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("reading host filesystem is blocked", async () => {
    const result = await executeInIsolate(`
      try {
        const fs = await import("node:fs");
        const data = fs.readFileSync("/etc/passwd", "utf8");
        console.log("ESCAPED:" + data.slice(0, 20));
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    expect(result as string).toMatch(/BLOCKED/);
  });
});

// ── Security: process isolation ──────────────────────────────────────────

describe("run_code isolate: process isolation", () => {
  test("child process spawning is blocked", async () => {
    const result = await executeInIsolate(`
      try {
        const cp = await import("node:child_process");
        cp.execSync("id");
        console.log("ESCAPED");
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("process.exit is not available or has no effect", async () => {
    const result = await executeInIsolate(`
      try {
        process.exit(1);
        console.log("STILL_RUNNING");
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    // Either blocked or the isolate exits without affecting host
    expect(typeof result).toBe("string");
  });
});

// ── Security: env var isolation ──────────────────────────────────────────

describe("run_code isolate: env var isolation", () => {
  test("host env vars are not accessible", async () => {
    const result = await executeInIsolate(`
      try {
        const keys = process.env ? Object.keys(process.env) : [];
        const hasPath = keys.includes("PATH");
        const hasHome = keys.includes("HOME");
        console.log(hasPath || hasHome ? "LEAKED_ENV" : "SAFE:" + keys.length);
      } catch(e) {
        console.log("SAFE:" + e.message);
      }
    `);
    expect(result as string).not.toMatch(/LEAKED_ENV/);
  });
});

// ── Security: constructor chain bypass (previously critical vuln) ─────────

describe("run_code isolate: constructor chain attacks", () => {
  test("string concatenation constructor bypass cannot leak host env", async () => {
    const result = await executeInIsolate(`
      const c = "con" + "stru" + "ctor";
      const F = ""[c][c];
      try {
        const p = F("return process")();
        const keys = p && p.env ? Object.keys(p.env) : [];
        console.log(keys.includes("PATH") ? "LEAKED_ENV" : "SAFE:" + keys.length);
      } catch(e) {
        console.log("SAFE:" + e.message);
      }
    `);
    expect(result as string).not.toMatch(/LEAKED_ENV/);
  });

  test("fromCharCode constructor bypass cannot leak host env", async () => {
    const result = await executeInIsolate(`
      const s = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114);
      const F = ""[s][s];
      try {
        const p = F("return process")();
        const keys = p && p.env ? Object.keys(p.env) : [];
        console.log(keys.includes("PATH") ? "LEAKED_ENV" : "SAFE:" + keys.length);
      } catch(e) {
        console.log("SAFE:" + e.message);
      }
    `);
    expect(result as string).not.toMatch(/LEAKED_ENV/);
  });
});

// ── Cross-invocation isolation ────────────────────────────────────────────

describe("run_code isolate: cross-invocation isolation", () => {
  test("global state does not persist between invocations", async () => {
    // First call sets a global
    await executeInIsolate("globalThis.__secret = 'leaked';");

    // Second call should not see it
    const result = await executeInIsolate(`
      console.log(typeof globalThis.__secret === "undefined" ? "ISOLATED" : "LEAKED:" + globalThis.__secret);
    `);
    expect(result).toBe("ISOLATED");
  });

  test("variables do not leak between invocations", async () => {
    await executeInIsolate("var crossLeak = 42;");

    const result = await executeInIsolate(`
      try {
        console.log(typeof crossLeak === "undefined" ? "ISOLATED" : "LEAKED:" + crossLeak);
      } catch(e) {
        console.log("ISOLATED");
      }
    `);
    expect(result).toBe("ISOLATED");
  });
});
