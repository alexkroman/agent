// Copyright 2025 the AAI authors. MIT license.

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test as baseTest, describe, type Mock, type MockInstance, vi } from "vitest";
import type { DirectoryBundleOutput } from "./_bundler.ts";
import type { LogLevel, NotifyLevel, Ui, UiPrompts, UiSpinner } from "./_ui.ts";

/**
 * Stub `process.exit` with a function that RETURNS, so the code after the exit
 * call (and the assertion on the spy) runs in the test.
 *
 * `process.exit` is declared to return `never`, so a hand-written stub that
 * returns normally cannot satisfy the signature, and every spec reached for its
 * own `(() => undefined) as never`. A bare `vi.fn<typeof process.exit>()` IS
 * that signature by construction and returns `undefined` when called, so the
 * implementation needs no cast at all. Where the code under test does nothing
 * after the exit, a stub that THROWS is the other cast-free option (see
 * `_output.test.ts`).
 *
 * `restoreMocks` puts the real `process.exit` back before the next test.
 */
export function stubProcessExit(): MockInstance<typeof process.exit> {
  return vi.spyOn(process, "exit").mockImplementation(vi.fn<typeof process.exit>());
}

/**
 * The package's `test`, extended with a `tmpDir` fixture: a fresh temp
 * directory per test that destructures it, removed after the test (pass or
 * fail). Fixtures are lazy, so a test that does not name `tmpDir` creates
 * nothing — a spec can import this `test` for every case in the file.
 *
 * The cleanup is `force` so an ENOENT (a test that removed the dir itself)
 * cannot replace the real assertion error with a filesystem one.
 */
export const test = baseTest.extend("tmpDir", async ({ task: _task }, { onCleanup }) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_test_"));
  onCleanup(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
});

/**
 * `err` is a filesystem EEXIST.
 *
 * Spelled out here rather than imported from `_utils.ts`, which has the same
 * predicate: `_dev-server.test.ts` and `_dev-env.test.ts` MOCK
 * `./_utils.ts` with a factory that imports `_dev-server-test-utils.ts`, which
 * imports THIS file — so importing `_utils.ts` from here closes a cycle
 * through the mock registry, and that HANGS the run rather than failing it
 * (see `aaiRuntimeModule`'s note on the same trap). Four lines of duplication
 * against a hang with no error message is the right trade.
 */
function isEexist(err: unknown): boolean {
  return err instanceof Error && "code" in err && typeof err.code === "string"
    ? err.code === "EEXIST"
    : false;
}

/**
 * Symlink this package's node_modules into a fixture project so the worker
 * wrapper's `@alexkroman1/aai/manifest` import (and any fixture import of
 * `zod`) resolves — a real project always has the SDK installed.
 *
 * The `"dir"` type argument is a no-op on POSIX and the only correct value on
 * Windows, where a symlink's kind is fixed at creation.
 *
 * ## An EEXIST is forgiven only when it is ALREADY THIS LINK
 *
 * A caller may link twice into the same fixture, so an EEXIST cannot simply be an
 * error — and for a long time it was simply IGNORED, which is worse. A fixture that
 * already holds a `node_modules` of its own keeps it, the SDK is never linked, and
 * the failure surfaces as `Could not resolve "@alexkroman1/aai/utils"` from esbuild
 * with no mention of a symlink anywhere: the exact "module-resolution error several
 * layers away from its cause" this rethrow exists to prevent, arriving through the
 * one path that did not rethrow.
 *
 * It is not hypothetical. A stray `node_modules/.vite` left in
 * `templates/transcription-workflow` by some earlier vite run travelled into the
 * COPY `template-workflows.test.ts` builds, silently won this EEXIST, and turned a
 * green tree red on one developer's machine and nowhere else — which reads as a bug
 * in the template rather than as detritus in a directory.
 *
 * So the target is inspected: our own link is a no-op, and anything else THROWS
 * naming what is there. Fixing the fixture is the caller's job — this helper cannot
 * know whether that directory was something the test meant to put there.
 */
export async function linkSdkNodeModules(dir: string): Promise<void> {
  const target = path.resolve(import.meta.dirname, "../node_modules");
  const link = path.join(dir, "node_modules");
  const failed = await fs
    .symlink(target, link, "dir")
    .then(() => undefined)
    .catch((err: unknown) => {
      if (isEexist(err)) return err;
      throw err;
    });
  if (failed === undefined) return;
  // `readlink` rather than `stat`: the question is what this entry IS, and a `stat`
  // would follow a link to some other package's tree and call it a match.
  const existing = await fs.readlink(link).catch(() => undefined);
  if (existing !== undefined && path.resolve(dir, existing) === target) return;
  throw new Error(
    `${link} already exists and is not a link to ${target}, so the SDK will not ` +
      "resolve there. A fixture that carries its own node_modules (stray build " +
      "output copied in, most likely) has to drop it before linking.",
    { cause: failed },
  );
}

/**
 * Symlink the REPO ROOT's node_modules instead — where pnpm hoists the
 * workspace's TypeScript, which this package's own tree does not carry. Only
 * the typecheck gate's fixtures need it.
 */
export async function linkRootNodeModules(dir: string): Promise<void> {
  await fs.symlink(
    path.resolve(import.meta.dirname, "../../../node_modules"),
    path.join(dir, "node_modules"),
    "dir",
  );
}

/** Write a map of relative path → content under `rootDir`, creating directories. */
export async function writeFiles(rootDir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(rootDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return rootDir;
}

/** One line a {@link FakeUi} recorded: which channel, and what it said. */
export type UiLine = { level: LogLevel | `notify:${NotifyLevel}`; message: string };

/** The prompts of a {@link FakeUi}, as spies a spec scripts or asserts on. */
export type FakePrompts = {
  confirm: Mock<UiPrompts["confirm"]>;
  text: Mock<UiPrompts["text"]>;
  password: Mock<UiPrompts["password"]>;
  select: Mock<UiPrompts["select"]>;
  spinner: () => UiSpinner;
  intro: Mock<UiPrompts["intro"]>;
  cancel: Mock<UiPrompts["cancel"]>;
  isCancel: UiPrompts["isCancel"];
};

/**
 * An in-memory {@link Ui}: what a command said, prompted and wrote, recorded
 * instead of printed. Pass it as the executor's `ui` (or `runCommand`'s /
 * `defineExec`'s) rather than `vi.mock("./_ui.ts")` or
 * `vi.mock("@clack/prompts")`.
 */
export type FakeUi = Ui & {
  /** Every `log.*` and `notify` call, in order. A silenced `log` records nothing. */
  readonly lines: UiLine[];
  /** Each `writeResult` call — the JSON result line(s). */
  readonly stdout: string[];
  /** Raw stderr lines, including a silenced `notify`. */
  readonly stderr: string[];
  /** The messages logged at `level` (a `notify` counts at its level). */
  said(level: LogLevel): string[];
  /** Every message, all levels, one string per call. */
  all(): string[];
  readonly prompts: FakePrompts;
  /** What `spinner()` was started and stopped with. */
  readonly spinner: { started: string[]; stopped: string[] };
};

/** The value a fake prompt answers to mean "the user pressed Ctrl-C". */
export const CANCEL: unique symbol = Symbol("fake-ui-cancel");

/**
 * Build a {@link FakeUi}. `silenced: true` starts it in JSON mode. Unscripted
 * prompts REJECT, so a spec that reaches a prompt it did not expect fails
 * naming the prompt rather than hanging on a terminal read.
 */
export function createFakeUi(opts: { silenced?: boolean } = {}): FakeUi {
  let silenced = opts.silenced ?? false;
  const lines: UiLine[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const spinner = { started: [] as string[], stopped: [] as string[] };
  const record = (level: LogLevel) => (message: string) => {
    if (!silenced) lines.push({ level, message });
  };
  const unscripted = (name: string) => () =>
    Promise.reject(new Error(`createFakeUi: unexpected ${name} prompt`));
  const prompts: FakePrompts = {
    confirm: vi.fn<UiPrompts["confirm"]>(unscripted("confirm")),
    text: vi.fn<UiPrompts["text"]>(unscripted("text")),
    password: vi.fn<UiPrompts["password"]>(unscripted("password")),
    select: vi.fn<UiPrompts["select"]>(unscripted("select")),
    spinner: () => ({
      start: (msg?: string) => spinner.started.push(msg ?? ""),
      stop: (msg?: string) => spinner.stopped.push(msg ?? ""),
    }),
    intro: vi.fn<UiPrompts["intro"]>(),
    cancel: vi.fn<UiPrompts["cancel"]>(),
    isCancel: (value: unknown): value is symbol => value === CANCEL,
  };
  const levelOf = (line: UiLine): LogLevel =>
    (line.level.startsWith("notify:") ? line.level.slice(7) : line.level) as LogLevel;
  return {
    log: {
      info: record("info"),
      success: record("success"),
      error: record("error"),
      warn: record("warn"),
      step: record("step"),
      message: record("message"),
    },
    notify(level, message) {
      if (silenced) stderr.push(message);
      else lines.push({ level: `notify:${level}`, message });
    },
    silence() {
      silenced = true;
    },
    get silenced() {
      return silenced;
    },
    async writeResult(line) {
      stdout.push(line);
    },
    writeOut(line) {
      stdout.push(line);
    },
    writeErr(line) {
      stderr.push(line);
    },
    prompts,
    lines,
    stdout,
    stderr,
    spinner,
    said: (level) => lines.filter((l) => levelOf(l) === level).map((l) => l.message),
    all: () => lines.map((l) => l.message),
  };
}

/** Create a minimal DirectoryBundleOutput for deploy tests. */
export function makeBundle(overrides?: Partial<DirectoryBundleOutput>): DirectoryBundleOutput {
  return {
    worker: "export default { name: 'test-agent', tools: {} };",
    clientFiles: {},
    ...overrides,
  };
}

/**
 * A project whose `node_modules` resolves the CLI as well as the SDK.
 *
 * {@link linkSdkNodeModules} symlinks this package's own `node_modules`, which
 * holds every dependency a bundled deployment entry needs but NOT
 * `@alexkroman1/aai-cli` itself — a package has no self-link — and every
 * target's entry imports that published subpath.
 *
 * Needed by the self-contained targets' scenario suites, which bundle an entry
 * and then run it. `_deno-output.scenario.test.ts` carries its own copy of this
 * for now; the two are the same helper and that one should switch over.
 */
export async function linkProjectNodeModules(dir: string): Promise<void> {
  await linkSdkNodeModules(dir);
  const packages = path.resolve(import.meta.dirname, "../..");
  const real = await fs.realpath(path.join(dir, "node_modules"));
  await fs.rm(path.join(dir, "node_modules"), { force: true });
  await fs.mkdir(path.join(dir, "node_modules", "@alexkroman1"), { recursive: true });
  for (const entry of await fs.readdir(real)) {
    if (entry === "@alexkroman1") continue;
    await fs.symlink(path.join(real, entry), path.join(dir, "node_modules", entry));
  }
  for (const pkg of ["aai", "aai-runtime", "aai-ui", "aai-cli"]) {
    await fs.symlink(
      path.join(packages, pkg),
      path.join(dir, "node_modules", "@alexkroman1", pkg),
      "dir",
    );
  }
}

/**
 * A binary this suite needs, and how a machine without it is told.
 *
 * @see describeWithBinary
 */
export interface BinaryGate {
  /** The binary, resolved on PATH. */
  readonly bin: string;
  /** The variable that turns a SKIP into a hard failure — declared in `turbo.json`. */
  readonly requireEnv: string;
  /** How to install it, printed with the skip. */
  readonly howTo: string;
  /** Args that make it print its version. Defaults to `--version`. */
  readonly versionArgs?: readonly string[];
  /**
   * What the skip says when the probe fails. Defaults to `no <bin> was found`;
   * a gate whose probe checks more than presence (a `-c "import x"`) names it.
   */
  readonly absent?: string;
  /**
   * The oldest version whose behaviour the suite asserts, as `x.y.z`.
   *
   * A binary that ANSWERS but is older is not the same case as one that is
   * absent, and conflating them is how a floor gets discovered twice: the arms
   * would fail on whatever the old version does differently, three assertions
   * deep, rather than saying the version is below the floor. So it is treated
   * like an absent binary — announced, skipped, and turned into a hard failure
   * by {@link BinaryGate.requireEnv} — with the floor named either way.
   */
  readonly minVersion?: string;
}

/** The first `x.y.z` in `--version` output, as numbers. */
function parseVersion(printed: string): number[] | undefined {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(printed);
  return found === null ? undefined : [Number(found[1]), Number(found[2]), Number(found[3])];
}

/** `a` is at least `b`, comparing numerically per component. */
function atLeast(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** What is on PATH: nothing, something too old, or a usable binary. */
export type BinaryState =
  | { kind: "ok"; version?: string }
  | { kind: "absent" }
  | { kind: "old"; version: string };

/**
 * Probe {@link BinaryGate.bin}. `spawnSync` rather than an `await`, because a
 * gate must be decided at COLLECTION time: a probe awaited in a test BODY can
 * only produce a pass or a fail, never a skip.
 */
export function binaryState(gate: BinaryGate): BinaryState {
  const args = [...(gate.versionArgs ?? ["--version"])];
  const probe = spawnSync(gate.bin, args, { encoding: "utf-8" });
  if (probe.status !== 0) return { kind: "absent" };
  const printed = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  if (gate.minVersion === undefined) return { kind: "ok" };
  const found = parseVersion(printed);
  const floor = parseVersion(gate.minVersion);
  // An unparsable version passes: a custom build printing something we cannot
  // read is a machine the developer chose, and refusing it would be this
  // helper deciding a version question it has no answer to.
  if (found === undefined || floor === undefined) return { kind: "ok", version: printed };
  return atLeast(found, floor)
    ? { kind: "ok", version: found.join(".") }
    : { kind: "old", version: found.join(".") };
}

// Biome's `noSkippedTests` flags the `describe.skip(…)` CALL form, so the gated
// suite below references it instead — exactly as `aai/host/ffmpeg.scenario.test.ts`
// and `_pg-test-utils.ts` do.
const skipSuite = describe.skip;

/**
 * A suite that needs a real binary — and whose skip ANNOUNCES itself.
 *
 * The generalisation of `describeWithDeno`, which generalised
 * `describeWithFfmpeg`, which followed `describeWithPg`. It is one helper
 * because the shape is one shape and the failure it prevents is one failure:
 * the Deno arm shipped as an `expect.soft(true, "deno not on PATH …")` inside
 * a test body — a skip spelled as a PASS — and since nothing in CI installed
 * Deno, the only case proving `aai build --target deno` emits a directory that
 * BOOTS reported green on every leg while checking nothing. That is the shape
 * AGENTS.md names a gate reporting success over a comparison it could not make.
 *
 * So: skip LOUDLY, and let {@link BinaryGate.requireEnv} — which CI sets only
 * once the binary really answered — turn the skip into a hard failure, so a
 * broken setup step cannot read as a green run either. The variable has to be
 * declared in that task's `env` in `turbo.json` or turbo's strict env mode
 * strips it before the task starts and the enforcement silently does nothing.
 */
export function describeWithBinary(gate: BinaryGate, name: string, body: () => void): void {
  const state = binaryState(gate);
  if (state.kind === "ok") {
    describe(name, body);
    return;
  }
  const why =
    state.kind === "old"
      ? `${gate.bin} ${state.version} is older than the ${String(gate.minVersion)} this suite asserts`
      : (gate.absent ?? `no ${gate.bin} was found`);
  if ((process.env[gate.requireEnv] ?? "") !== "") {
    throw new Error(`${gate.requireEnv} is set but ${why}.\n${gate.howTo}`);
  }
  console.warn(`\n[skipped: ${why}] ${name}\n${gate.howTo}\n`);
  skipSuite(name, body);
}
