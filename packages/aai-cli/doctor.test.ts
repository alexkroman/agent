// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { withTempDir } from "./_test-utils.ts";
import { _runDoctor, runDoctorCommand } from "./doctor.ts";

function collect() {
  const lines: string[] = [];
  return { log: (msg: string) => lines.push(msg), lines };
}

describe("doctor", () => {
  const origApiKey = process.env.ASSEMBLYAI_API_KEY;

  afterEach(() => {
    if (origApiKey !== undefined) {
      process.env.ASSEMBLYAI_API_KEY = origApiKey;
    } else {
      delete process.env.ASSEMBLYAI_API_KEY;
    }
    process.exitCode = undefined;
  });

  test("reports pass for Node version (test env is >=22.6)", async () => {
    const { log, lines } = collect();
    await withTempDir(async (dir) => {
      process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
      await _runDoctor(dir, 0, log);
    });
    const nodeCheck = lines.find((l) => l.includes("Node.js"));
    expect(nodeCheck).toContain("✓");
  });

  test("reports pass when ASSEMBLYAI_API_KEY is set", async () => {
    const { log, lines } = collect();
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
    await withTempDir(async (dir) => {
      await _runDoctor(dir, 0, log);
    });
    const apiCheck = lines.find((l) => l.includes("API key"));
    expect(apiCheck).toContain("✓");
  });

  test("reports fail when no agent.ts exists", async () => {
    const { log, lines } = collect();
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
    await withTempDir(async (dir) => {
      await _runDoctor(dir, 0, log);
    });
    const agentCheck = lines.find((l) => l.includes("agent.ts"));
    expect(agentCheck).toContain("✗");
    expect(process.exitCode).toBe(1);
  });

  test("reports warn when .env.example exists but .env does not", async () => {
    const { log, lines } = collect();
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".env.example"), "FOO=bar\n");
      await _runDoctor(dir, 0, log);
    });
    const envCheck = lines.find((l) => l.includes(".env file"));
    expect(envCheck).toContain("!");
  });

  test("reports pass for .env with populated keys", async () => {
    const { log, lines } = collect();
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".env"), "FOO=bar\nBAZ=qux\n");
      await _runDoctor(dir, 0, log);
    });
    const envCheck = lines.find((l) => l.includes(".env file"));
    expect(envCheck).toContain("✓");
    expect(envCheck).toContain("2 key(s)");
  });

  test("reports warn for .env with empty values", async () => {
    const { log, lines } = collect();
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".env"), "FOO=\nBAZ=qux\n");
      await _runDoctor(dir, 0, log);
    });
    const envCheck = lines.find((l) => l.includes(".env file"));
    expect(envCheck).toContain("!");
    expect(envCheck).toContain("FOO");
  });

  test("reports fail when no node_modules", async () => {
    const { log, lines } = collect();
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "package.json"), "{}");
      await _runDoctor(dir, 0, log);
    });
    const depCheck = lines.find((l) => l.includes("Dependencies"));
    expect(depCheck).toContain("✗");
  });

  test("reports warn for port in use", async () => {
    const { log, lines } = collect();
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";

    // Occupy a port
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as net.AddressInfo).port);
      });
    });

    try {
      await withTempDir(async (dir) => {
        await _runDoctor(dir, port, log);
      });
      const portCheck = lines.find((l) => l.includes("Port"));
      expect(portCheck).toContain("!");
      expect(portCheck).toContain("in use");
    } finally {
      server.close();
    }
  });

  test("reports pass for available port", async () => {
    const { log, lines } = collect();
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
    await withTempDir(async (dir) => {
      await _runDoctor(dir, 0, log);
    });
    const portCheck = lines.find((l) => l.includes("Port"));
    expect(portCheck).toContain("✓");
  });

  test("prints fix suggestions for failures", async () => {
    const { log, lines } = collect();
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
    await withTempDir(async (dir) => {
      await _runDoctor(dir, 0, log);
    });
    // agent.ts not found should have a fix suggestion
    const fixLine = lines.find((l) => l.includes("aai init"));
    expect(fixLine).toBeDefined();
  });

  test("prints summary line", async () => {
    const { log, lines } = collect();
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
    await withTempDir(async (dir) => {
      await _runDoctor(dir, 0, log);
    });
    const summary = lines.find(
      (l) => l.includes("issue(s) found") || l.includes("looks good") || l.includes("warning(s)"),
    );
    expect(summary).toBeDefined();
  });

  test("runDoctorCommand rejects invalid port", async () => {
    await expect(runDoctorCommand({ cwd: "/tmp", port: "abc" })).rejects.toThrow("Invalid port");
  });

  test("runDoctorCommand runs successfully with valid port", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key-123456";
    await withTempDir(async (dir) => {
      // Suppress console.log from runCommand
      const orig = console.log;
      console.log = () => {
        /* noop */
      };
      try {
        await runDoctorCommand({ cwd: dir, port: "0" });
      } finally {
        console.log = orig;
      }
    });
  });
});
