// Copyright 2025 the AAI authors. MIT license.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import pc from "picocolors";
import { fileExists } from "./_discover.ts";
import { envFileKeys, loadAgentDef } from "./_server-common.ts";
import { runCommand, step } from "./_ui.ts";

const execFileAsync = promisify(execFile);

type CheckResult = {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: string;
};

const PASS = pc.green("✓");
const WARN = pc.yellow("!");
const FAIL = pc.red("✗");

function statusIcon(status: CheckResult["status"]): string {
  if (status === "pass") return PASS;
  if (status === "warn") return WARN;
  return FAIL;
}

// ── Individual checks ──────────────────────────────────────────────

async function checkNodeVersion(): Promise<CheckResult> {
  const version = process.version; // e.g. "v22.6.0"
  const match = version.match(/^v(\d+)\.(\d+)/);
  if (!match) {
    return { name: "Node.js", status: "fail", message: `Unknown version: ${version}` };
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major > 22 || (major === 22 && minor >= 6)) {
    return { name: "Node.js", status: "pass", message: `${version} (>=22.6 required)` };
  }
  return {
    name: "Node.js",
    status: "fail",
    message: `${version} — Node >=22.6 is required`,
    fix: "Install Node.js 22.6+ from https://nodejs.org or via nvm: nvm install 22",
  };
}

async function checkApiKey(): Promise<CheckResult> {
  const key =
    process.env.ASSEMBLYAI_API_KEY ||
    (await (async () => {
      try {
        const configPath = path.join(
          process.env.HOME ?? process.env.USERPROFILE ?? ".",
          ".config",
          "aai",
          "config.json",
        );
        const raw = JSON.parse(await fs.readFile(configPath, "utf-8"));
        return raw.assemblyai_api_key as string | undefined;
      } catch {
        // Config file not found or invalid — not an error
      }
    })());

  if (!key) {
    return {
      name: "API key",
      status: "fail",
      message: "ASSEMBLYAI_API_KEY not found",
      fix: "Run `aai init` to set up your API key, or set the ASSEMBLYAI_API_KEY environment variable",
    };
  }

  // Basic format check — AssemblyAI keys are hex-ish strings
  if (key.length < 10) {
    return {
      name: "API key",
      status: "warn",
      message: "ASSEMBLYAI_API_KEY looks too short — may be invalid",
      fix: "Get a valid key from https://www.assemblyai.com/dashboard/signup",
    };
  }

  return { name: "API key", status: "pass", message: "ASSEMBLYAI_API_KEY is set" };
}

async function checkDependencies(cwd: string): Promise<CheckResult> {
  const pkgPath = path.join(cwd, "package.json");
  if (!(await fileExists(pkgPath))) {
    return {
      name: "Dependencies",
      status: "warn",
      message: "No package.json found",
      fix: "Run `aai init` to scaffold a project, or `npm init` to create package.json",
    };
  }

  const nodeModules = path.join(cwd, "node_modules");
  if (!(await fileExists(nodeModules))) {
    return {
      name: "Dependencies",
      status: "fail",
      message: "node_modules/ not found — dependencies not installed",
      fix: "Run `npm install` to install dependencies",
    };
  }

  // Check that @alexkroman1/aai is installed
  const aaiPkg = path.join(nodeModules, "@alexkroman1", "aai");
  if (!(await fileExists(aaiPkg))) {
    return {
      name: "Dependencies",
      status: "fail",
      message: "@alexkroman1/aai package not found in node_modules",
      fix: "Run `npm install @alexkroman1/aai` to add the SDK",
    };
  }

  return { name: "Dependencies", status: "pass", message: "node_modules/ present, SDK installed" };
}

async function checkEnvFile(cwd: string): Promise<CheckResult> {
  const envPath = path.join(cwd, ".env");
  if (!(await fileExists(envPath))) {
    const examplePath = path.join(cwd, ".env.example");
    if (await fileExists(examplePath)) {
      return {
        name: ".env file",
        status: "warn",
        message: ".env not found, but .env.example exists",
        fix: "Copy .env.example to .env and fill in the values: cp .env.example .env",
      };
    }
    return {
      name: ".env file",
      status: "pass",
      message: "No .env file (using environment variables or aai config)",
    };
  }

  try {
    const content = await fs.readFile(envPath, "utf-8");
    const keys = envFileKeys(content);
    if (keys.length === 0) {
      return {
        name: ".env file",
        status: "warn",
        message: ".env file is empty (no keys declared)",
      };
    }

    // Check for keys with empty values
    const emptyKeys: string[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const val = trimmed.slice(eq + 1).trim();
      if (!val || val === '""' || val === "''") {
        emptyKeys.push(trimmed.slice(0, eq).trim());
      }
    }

    if (emptyKeys.length > 0) {
      return {
        name: ".env file",
        status: "warn",
        message: `${keys.length} key(s) declared, ${emptyKeys.length} empty: ${emptyKeys.join(", ")}`,
        fix: "Fill in the empty values in your .env file",
      };
    }

    return { name: ".env file", status: "pass", message: `${keys.length} key(s) declared` };
  } catch {
    return { name: ".env file", status: "fail", message: "Failed to read .env file" };
  }
}

async function checkPortAvailable(port: number): Promise<CheckResult> {
  const available = await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });

  if (available) {
    return { name: "Port", status: "pass", message: `Port ${port} is available` };
  }
  return {
    name: "Port",
    status: "warn",
    message: `Port ${port} is in use`,
    fix: `Use a different port: aai dev --port <number>, or stop the process using port ${port}`,
  };
}

async function checkAgentSyntax(cwd: string): Promise<CheckResult> {
  const agentPath = path.join(cwd, "agent.ts");
  if (!(await fileExists(agentPath))) {
    return {
      name: "agent.ts",
      status: "fail",
      message: "agent.ts not found",
      fix: "Run `aai init` to scaffold a new agent project",
    };
  }

  // Try to load and validate the agent definition
  try {
    await loadAgentDef(cwd);
    return { name: "agent.ts", status: "pass", message: "Valid agent definition" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "agent.ts",
      status: "fail",
      message: `Invalid: ${msg}`,
      fix: "Check agent.ts — ensure it exports a default defineAgent() call with name, instructions, greeting, maxSteps, and tools",
    };
  }
}

async function checkTypeScript(cwd: string): Promise<CheckResult> {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  if (!(await fileExists(tsconfigPath))) {
    return {
      name: "TypeScript",
      status: "pass",
      message: "No tsconfig.json (using Node native TS)",
    };
  }

  try {
    await execFileAsync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
      cwd,
      timeout: 30_000,
    });
    return { name: "TypeScript", status: "pass", message: "No type errors" };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const lines = stderr.split("\n").filter((l) => l.includes("error TS"));
    const count = lines.length;
    return {
      name: "TypeScript",
      status: "warn",
      message: `${count || "Some"} type error(s) found`,
      fix: "Run `npx tsc --noEmit` to see full type errors",
    };
  }
}

// ── Main ───────────────────────────────────────────────────────────

export async function _runDoctor(
  cwd: string,
  port: number,
  log: (msg: string) => void,
): Promise<void> {
  log("");
  log(step("Doctor", "Checking environment health..."));
  log("");

  const results: CheckResult[] = [];

  // Run checks that don't depend on cwd first
  results.push(await checkNodeVersion());
  results.push(await checkApiKey());

  // Project-level checks
  results.push(await checkDependencies(cwd));
  results.push(await checkEnvFile(cwd));
  results.push(await checkPortAvailable(port));
  results.push(await checkAgentSyntax(cwd));
  results.push(await checkTypeScript(cwd));

  // Print results
  for (const r of results) {
    const icon = statusIcon(r.status);
    log(`  ${icon} ${pc.bold(r.name)}: ${r.message}`);
    if (r.fix) {
      log(pc.dim(`    → ${r.fix}`));
    }
  }

  log("");

  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;

  if (fails > 0) {
    log(`  ${FAIL} ${fails} issue(s) found. Fix them to proceed.`);
  } else if (warns > 0) {
    log(`  ${WARN} All clear with ${warns} warning(s).`);
  } else {
    log(`  ${PASS} Everything looks good!`);
  }

  log("");

  if (fails > 0) {
    process.exitCode = 1;
  }
}

export async function runDoctorCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = Number.parseInt(opts.port, 10);
  if (Number.isNaN(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${opts.port}. Must be a number between 0 and 65535.`);
  }

  await runCommand(async ({ log }) => {
    await _runDoctor(opts.cwd, port, log);
  });
}
