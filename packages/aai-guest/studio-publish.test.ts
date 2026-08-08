// Copyright 2026 the AAI authors. MIT license.
// Guest-side Publish: `deployWorkspaceDir` shapes the aai CLI's `--json`
// output into the chat-facing result. A stub CLI script stands in for the
// real one (the real end-to-end pass — real CLI, real orchestrator — lives
// in aai-server's workspace-build-integration.test.ts); these tests pin the
// parsing, the project-shape/side-file writes, and the failure surfaces.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { deployWorkspaceDir, resolveCliEntry } from "./studio-publish.ts";

let dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "aai-publish-"));
  dirs.push(dir);
  return dir;
}

/**
 * Write a stub "CLI" that prints canned stdout/stderr and exits with a
 * chosen code — deployWorkspaceDir only sees the child's streams and exit,
 * so this exercises every parse path without a network or a build.
 */
async function makeFakeCli(behavior: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): Promise<string> {
  const dir = await makeDir();
  const entry = path.join(dir, "fake-cli.mjs");
  await writeFile(
    entry,
    [
      `process.stdout.write(${JSON.stringify(behavior.stdout ?? "")});`,
      `process.stderr.write(${JSON.stringify(behavior.stderr ?? "")});`,
      `process.exit(${behavior.exitCode ?? 0});`,
    ].join("\n"),
    "utf-8",
  );
  return entry;
}

/**
 * A stub CLI that records the argv it was spawned with. The flags Publish
 * passes are part of its contract with the platform's deploy boundary, so
 * they need to be assertable, not just inferred from a success line.
 */
async function makeArgvRecordingCli(): Promise<{
  cliEntry: string;
  readArgv: () => Promise<string[]>;
}> {
  const dir = await makeDir();
  const entry = path.join(dir, "argv-cli.mjs");
  const argvFile = path.join(dir, "argv.json");
  await writeFile(
    entry,
    [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(${JSON.stringify(
        `${JSON.stringify({ ok: true, data: { slug: "s", url: "u" } })}\n`,
      )});`,
    ].join("\n"),
    "utf-8",
  );
  return {
    cliEntry: entry,
    readArgv: async () => JSON.parse(await readFile(argvFile, "utf-8")) as string[],
  };
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("resolveCliEntry", () => {
  test("locates a runnable aai CLI entry from the toolchain", async () => {
    const entry = await resolveCliEntry();
    // An existing file inside the aai-cli package — the bin the guest spawns.
    expect(entry).toContain("aai-cli");
    await expect(readFile(entry, "utf-8")).resolves.toBeTruthy();
  });
});

describe("deployWorkspaceDir", () => {
  test("a successful deploy reports the URL, slug, and warnings", async () => {
    const dir = await makeDir();
    const cliEntry = await makeFakeCli({
      stdout: `progress line\n${JSON.stringify({
        ok: true,
        data: { slug: "demo", url: "https://x.test/demo", warnings: ["ASSEMBLYAI_API_KEY unset"] },
      })}\n`,
    });
    const result = await deployWorkspaceDir(dir, {
      serverUrl: "https://x.test",
      apiKey: "k",
      slug: "demo",
      cliEntry,
    });
    expect(result).toMatchObject({ ok: true, slug: "demo", url: "https://x.test/demo" });
    expect(result.output).toContain("Deployed https://x.test/demo");
    expect(result.output).toContain("warning: ASSEMBLYAI_API_KEY unset");
  });

  test("completes the workspace shape and pins the slug for redeploys", async () => {
    const dir = await makeDir();
    const cliEntry = await makeFakeCli({
      stdout: `${JSON.stringify({ ok: true, data: { slug: "demo", url: "u" } })}\n`,
    });
    await deployWorkspaceDir(dir, {
      serverUrl: "https://x.test",
      apiKey: "k",
      slug: "demo",
      cliEntry,
    });
    // ensureProjectShape ran: the CLI sees a real project.
    await expect(readFile(path.join(dir, "tsconfig.json"), "utf-8")).resolves.toBeTruthy();
    // The caller's key landed in the dir-local config home, mode-restricted —
    // a property of the CLI's own writer, and invisible in the JSON, which is
    // why this asserts the mode rather than trusting the shape.
    const configPath = path.join(dir, ".aai-home", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    expect(config).toEqual({ apiKey: "k" });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    // The slug pin keeps the agent's URL stable across publishes.
    const pin = JSON.parse(await readFile(path.join(dir, ".aai", "project.json"), "utf-8"));
    expect(pin).toEqual({ slug: "demo", serverUrl: "https://x.test" });
  });

  test("the slug pin MERGES — an existing project.json keeps its other fields", async () => {
    const dir = await makeDir();
    const cliEntry = await makeFakeCli({
      stdout: `${JSON.stringify({ ok: true, data: { slug: "demo", url: "u" } })}\n`,
    });
    // A materialized workspace can already carry the studio link fields; a
    // writer that REPLACES the document silently drops them.
    await mkdir(path.join(dir, ".aai"), { recursive: true });
    await writeFile(
      path.join(dir, ".aai", "project.json"),
      JSON.stringify({
        serverUrl: "https://old.test",
        studioProject: "demo",
        studioSourceHash: "abc",
      }),
      "utf-8",
    );
    await deployWorkspaceDir(dir, {
      serverUrl: "https://x.test",
      apiKey: "k",
      slug: "demo",
      cliEntry,
    });
    const pin = JSON.parse(await readFile(path.join(dir, ".aai", "project.json"), "utf-8"));
    expect(pin).toEqual({
      studioProject: "demo",
      studioSourceHash: "abc",
      slug: "demo",
      serverUrl: "https://x.test",
    });
  });

  test("no slug means no pin — the CLI generates one", async () => {
    const dir = await makeDir();
    const cliEntry = await makeFakeCli({
      stdout: `${JSON.stringify({ ok: true, data: { slug: "generated", url: "u" } })}\n`,
    });
    const result = await deployWorkspaceDir(dir, {
      serverUrl: "https://x.test",
      apiKey: "k",
      cliEntry,
    });
    expect(result.ok).toBe(true);
    await expect(readFile(path.join(dir, ".aai", "project.json"), "utf-8")).rejects.toThrow();
  });

  test("a production Publish does not opt into the reserved -preview suffix", async () => {
    const dir = await makeDir();
    const { cliEntry, readArgv } = await makeArgvRecordingCli();
    await deployWorkspaceDir(dir, {
      serverUrl: "https://x.test",
      apiKey: "k",
      // A project literally named `*-preview` still deploys as a PRODUCTION
      // slug — the opt-in must come from the caller's intent, not the slug's
      // shape, or the studio's own reaper would sweep the user's agent.
      slug: "sneaky-preview",
      cliEntry,
    });
    expect(await readArgv()).not.toContain("--allow-preview-slug");
  });

  test("an auto-preview deploy opts into the -preview suffix explicitly", async () => {
    const dir = await makeDir();
    const { cliEntry, readArgv } = await makeArgvRecordingCli();
    await deployWorkspaceDir(dir, {
      serverUrl: "https://x.test",
      apiKey: "k",
      slug: "demo-preview",
      allowPreviewSlug: true,
      cliEntry,
    });
    expect(await readArgv()).toContain("--allow-preview-slug");
  });

  test("a CLI error result surfaces its message and hint", async () => {
    const dir = await makeDir();
    const cliEntry = await makeFakeCli({
      exitCode: 1,
      stdout: `${JSON.stringify({
        ok: false,
        error: "Type check failed:\nagent.ts(1,1): error TS2322",
        code: "typecheck_failed",
        hint: "Fix the type errors, or pass --skipTypecheck to build anyway",
      })}\n`,
    });
    const result = await deployWorkspaceDir(dir, {
      serverUrl: "https://x.test",
      apiKey: "k",
      cliEntry,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Type check failed");
    expect(result.output).toContain("--skipTypecheck");
  });

  test("a CLI error without a hint is just the error", async () => {
    const dir = await makeDir();
    const cliEntry = await makeFakeCli({
      exitCode: 1,
      stdout: `${JSON.stringify({ ok: false, error: "slug is reserved", code: "bad_slug" })}\n`,
    });
    const result = await deployWorkspaceDir(dir, {
      serverUrl: "https://x.test",
      apiKey: "k",
      cliEntry,
    });
    expect(result).toEqual({ ok: false, output: "slug is reserved" });
  });

  test("a CLI that dies before reporting surfaces exit code and both streams", async () => {
    const dir = await makeDir();
    const cliEntry = await makeFakeCli({
      exitCode: 7,
      stdout: "some progress\n",
      stderr: "boom: out of nowhere\n",
    });
    const result = await deployWorkspaceDir(dir, {
      serverUrl: "https://x.test",
      apiKey: "k",
      cliEntry,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("aai deploy exited with 7");
    expect(result.output).toContain("some progress");
    expect(result.output).toContain("boom: out of nowhere");
  });

  test("workspace paths are scrubbed from the CLI's diagnostics", async () => {
    const dir = await makeDir();
    const cliEntry = await makeFakeCli({
      exitCode: 1,
      stdout: `${JSON.stringify({
        ok: false,
        error: `Build failed:\n${path.join("<DIR>", "agent.ts")}: something broke`,
        code: "build_failed",
      })}\n`,
    });
    // The stub can't know its cwd at authoring time — rewrite the placeholder.
    await writeFile(
      cliEntry,
      (await readFile(cliEntry, "utf-8")).replaceAll("<DIR>", dir.replaceAll("\\", "\\\\")),
      "utf-8",
    );
    const result = await deployWorkspaceDir(dir, {
      serverUrl: "https://x.test",
      apiKey: "k",
      cliEntry,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("agent.ts: something broke");
    expect(result.output).not.toContain(dir);
  });
});
