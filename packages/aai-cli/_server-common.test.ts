// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadAgentDef, parseEnvFile, resolveServerEnv } from "./_server-common.ts";
import { withTempDir } from "./_test-utils.ts";

describe("parseEnvFile", () => {
  test("parses KEY=VALUE pairs", () => {
    expect(parseEnvFile("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("skips comments and blank lines", () => {
    expect(parseEnvFile("# comment\n\nFOO=bar\n  # another")).toEqual({ FOO: "bar" });
  });

  test("strips double quotes", () => {
    expect(parseEnvFile('KEY="hello world"')).toEqual({ KEY: "hello world" });
  });

  test("strips single quotes", () => {
    expect(parseEnvFile("KEY='hello world'")).toEqual({ KEY: "hello world" });
  });

  test("handles empty values", () => {
    expect(parseEnvFile("KEY=")).toEqual({ KEY: "" });
  });

  test("handles values with = sign", () => {
    expect(parseEnvFile("KEY=a=b=c")).toEqual({ KEY: "a=b=c" });
  });

  test("trims whitespace around keys and values", () => {
    expect(parseEnvFile("  KEY  =  value  ")).toEqual({ KEY: "value" });
  });

  test("skips lines without =", () => {
    expect(parseEnvFile("NOEQ\nFOO=bar")).toEqual({ FOO: "bar" });
  });
});

describe("resolveServerEnv", () => {
  test("returns env with existing ASSEMBLYAI_API_KEY", async () => {
    const env = await resolveServerEnv(undefined, { ASSEMBLYAI_API_KEY: "test-key-123" });
    expect(env.ASSEMBLYAI_API_KEY).toBe("test-key-123");
  });

  test("returned env contains all provided entries", async () => {
    const env = await resolveServerEnv(undefined, {
      ASSEMBLYAI_API_KEY: "key",
      NODE_ENV: "test",
    });
    expect(env.NODE_ENV).toBe("test");
    expect(env.ASSEMBLYAI_API_KEY).toBe("key");
  });

  test("filters out undefined values", async () => {
    const env = await resolveServerEnv(undefined, {
      ASSEMBLYAI_API_KEY: "key",
      MISSING: undefined,
    });
    expect(env).not.toHaveProperty("MISSING");
  });

  test("preserves multiple defined values", async () => {
    const env = await resolveServerEnv(undefined, {
      ASSEMBLYAI_API_KEY: "key",
      FOO: "bar",
      BAZ: "qux",
    });
    expect(env.FOO).toBe("bar");
    expect(env.BAZ).toBe("qux");
  });

  test("loads .env file when cwd is provided", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".env"), "MY_SECRET=from-dotenv\nASSEMBLYAI_API_KEY=key");
      const env = await resolveServerEnv(dir, {});
      expect(env.MY_SECRET).toBe("from-dotenv");
    });
  });

  test("process env takes precedence over .env", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, ".env"), "MY_KEY=from-file\nASSEMBLYAI_API_KEY=key");
      const env = await resolveServerEnv(dir, {
        MY_KEY: "from-process",
        ASSEMBLYAI_API_KEY: "key",
      });
      expect(env.MY_KEY).toBe("from-process");
    });
  });

  test("returns process env only when no .env file exists", async () => {
    await withTempDir(async (dir) => {
      const env = await resolveServerEnv(dir, {
        ASSEMBLYAI_API_KEY: "key",
        FOO: "bar",
      });
      expect(env.FOO).toBe("bar");
    });
  });
});

describe("loadAgentDef", () => {
  test("throws when agent.ts does not exist", async () => {
    await withTempDir(async (dir) => {
      await expect(loadAgentDef(dir)).rejects.toThrow();
    });
  });

  test("throws when agent.ts has no default export", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export const foo = 42;");
      await expect(loadAgentDef(dir)).rejects.toThrow(
        "agent.ts must export a default agent definition",
      );
    });
  });

  test("throws when default export has no name", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default { instructions: 'hi' };");
      await expect(loadAgentDef(dir)).rejects.toThrow(
        "agent.ts must export a default agent definition",
      );
    });
  });

  test("returns agent def when using defineAgent", async () => {
    await withTempDir(async (dir) => {
      // Use defineAgent to match real usage
      await fs.writeFile(
        path.join(dir, "agent.ts"),
        [
          `import { defineAgent } from "${import.meta.resolve("@alexkroman1/aai").replace("file://", "")}";`,
          `export default defineAgent({ name: "test-agent" });`,
        ].join("\n"),
      );
      const def = await loadAgentDef(dir);
      expect(def.name).toBe("test-agent");
    });
  });

  test("throws when default export is null", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), "export default null;");
      await expect(loadAgentDef(dir)).rejects.toThrow(
        "agent.ts must export a default agent definition",
      );
    });
  });

  test("throws when default export is a string", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), 'export default "not an object";');
      await expect(loadAgentDef(dir)).rejects.toThrow(
        "agent.ts must export a default agent definition",
      );
    });
  });

  test("throws when required fields are missing from plain object", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), 'export default { name: "test" };');
      await expect(loadAgentDef(dir)).rejects.toThrow("Invalid agent definition");
      await expect(loadAgentDef(dir)).rejects.toThrow("instructions (string)");
      await expect(loadAgentDef(dir)).rejects.toThrow("greeting (string)");
      await expect(loadAgentDef(dir)).rejects.toThrow("maxSteps (number or function)");
      await expect(loadAgentDef(dir)).rejects.toThrow("tools (object)");
    });
  });

  test("throws when tools is an array instead of object", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "agent.ts"),
        'export default { name: "test", instructions: "hi", greeting: "hello", maxSteps: 5, tools: [] };',
      );
      await expect(loadAgentDef(dir)).rejects.toThrow("tools (object)");
    });
  });

  test("accepts valid plain object with all required fields", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, "agent.ts"),
        'export default { name: "test", instructions: "hi", greeting: "hello", maxSteps: 5, tools: {} };',
      );
      const def = await loadAgentDef(dir);
      expect(def.name).toBe("test");
    });
  });

  test("suggests using defineAgent in error message", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "agent.ts"), 'export default { name: "test" };');
      await expect(loadAgentDef(dir)).rejects.toThrow("Use defineAgent()");
    });
  });
});
