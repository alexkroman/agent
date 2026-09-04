// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { patchPackageJsonForWorkspace, runInit } from "./_init.ts";
import { silenced, withTempDir, writeFiles } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";
import { executeInit, promptTemplate, resolvePnpmCommand } from "./init.ts";

/**
 * Create a fake templates root (real scaffold files + test extras) and point
 * template resolution at it via AAI_TEMPLATES_DIR.
 */
async function useFakeTemplates(dir: string): Promise<void> {
  const rootDir = path.join(dir, "fake-root");
  // Copy real scaffold files so tests validate actual scaffold content
  const realScaffold = path.resolve(import.meta.dirname, "../../aai-templates/scaffold");
  await fs.cp(realScaffold, path.join(rootDir, "scaffold"), { recursive: true });
  await writeFiles(rootDir, {
    "scaffold/shared.txt": "from shared",
    "scaffold/.env.example": "MY_KEY=",
    "templates/simple/agent.json": JSON.stringify({ name: "Default Name" }),
    "templates/simple/readme.txt": "hello",
    // Empty package.json. It no longer keeps the install away — the scaffold's
    // dependencies are merged UNDER a template manifest rather than skipped
    // (layerScaffold) — so tests that reach installDeps stub execa.
    "templates/simple/package.json": "{}",
  });
  vi.stubEnv("AAI_TEMPLATES_DIR", rootDir);
}

/**
 * `init` SCAFFOLDS and stops — it must never publish. The mock is kept
 * precisely so that stays asserted rather than assumed: it used to deploy to
 * production as a side effect of creating a directory, and the specs below
 * would pass either way without something recording the call that must not
 * happen.
 */
const executePublish = vi.hoisted(() => vi.fn());
vi.mock("./studio.ts", () => ({ executePublish }));

/**
 * Real clack with a RECORDING spinner, so a spec can assert the spinner was
 * stopped. Everything else (intro, text) stays the real thing — only the one
 * affordance under test is replaced.
 */
const spinnerCalls = vi.hoisted(() => ({ started: [] as string[], stopped: [] as string[] }));
/**
 * The template picker, recorded. Its default answers with `initialValue` — a
 * user pressing Enter — so a spec asserting the picker was NOT reached
 * (`--yes`, JSON mode) fails on the call count rather than on a stray
 * `undefined` three functions later.
 */
const selectMock = vi.hoisted(() =>
  vi.fn(({ initialValue }: { initialValue?: unknown }) => Promise.resolve(initialValue)),
);
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  spinner: () => ({
    start: (msg?: string) => spinnerCalls.started.push(msg ?? ""),
    stop: (msg?: string) => spinnerCalls.stopped.push(msg ?? ""),
  }),
  select: selectMock,
}));

// executeInit shells out (corepack/safe-chain/pnpm) only when the scaffolded
// project has dependencies; mock execa so those paths are testable hermetically.
const execaMock = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: execaMock }));

/** Add a template whose package.json declares deps, so installDeps runs. */
async function addDepsTemplate(dir: string): Promise<void> {
  await writeFiles(path.join(dir, "fake-root"), {
    "templates/deps/agent.json": JSON.stringify({ name: "Deps" }),
    "templates/deps/package.json": JSON.stringify({ dependencies: { zod: "^4.0.0" } }),
  });
}

describe("runInit", () => {
  test("copies template and shared files to target", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple" });
        expect(await fs.readFile(path.join(target, "agent.json"), "utf-8")).toContain(
          "Default Name",
        );
        expect(await fs.readFile(path.join(target, "readme.txt"), "utf-8")).toBe("hello");
        expect(await fs.readFile(path.join(target, "shared.txt"), "utf-8")).toBe("from shared");
      }),
    );
  });

  test("skips node_modules", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple" });
        expect(await fileExists(path.join(target, "node_modules"))).toBe(false);
        expect(await fileExists(path.join(target, "package.json"))).toBe(true);
      }),
    );
  });

  test("copies .env.example to .env from shared", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple" });
        expect(await fileExists(path.join(target, ".env"))).toBe(true);
        expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("MY_KEY=");
      }),
    );
  });
});

describe("resolvePnpmCommand", () => {
  test("uses safe-chain when available", async () => {
    const result = await resolvePnpmCommand(() => Promise.resolve(true));
    expect(result.cmd).toBe("safe-chain");
    expect(result.args).toContain("pnpm");
    expect(result.args).toContain("--safe-chain-skip-minimum-package-age");
  });

  test("falls back to pnpm when safe-chain is not available", async () => {
    const result = await resolvePnpmCommand(() => Promise.resolve(false));
    expect(result.cmd).toBe("pnpm");
    expect(result.args).not.toContain("--safe-chain-skip-minimum-package-age");
  });
});

describe("scaffold client.tsx", () => {
  test("scaffold does not include client.tsx (default UI served by dev server)", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple" });
        const clientPath = path.join(target, "client.tsx");
        expect(await fileExists(clientPath)).toBe(false);
      }),
    );
  });
});

describe("executeInit", () => {
  beforeEach(() => {
    executePublish.mockReset();
    execaMock.mockReset();
    // `restoreMocks` restores SPIES; a factory `vi.fn()` was never one, so its
    // calls would accumulate across this file and turn every "was not called"
    // assertion below into an assertion about test order.
    selectMock.mockClear();
  });

  test("installs deps when the template declares dependencies", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        await addDepsTemplate(dir);
        const target = path.join(dir, "with-deps");
        // corepack enable ok (Node 24 only; absent on 25+), safe-chain missing, pnpm install ok
        execaMock.mockImplementation((cmd: string) =>
          Promise.resolve({ failed: cmd === "safe-chain" }),
        );
        const result = await executeInit({ dir: target, template: "deps" }, { silent: true });

        expect(result.ok).toBe(true);
        expect(executePublish).not.toHaveBeenCalled();
        const pnpmCall = execaMock.mock.calls.find(([cmd]) => cmd === "pnpm");
        expect(pnpmCall?.[1]).toContain("install");
        expect(pnpmCall?.[2]).toEqual({ cwd: target });
      }),
    );
  });

  test("routes the install through safe-chain when it is on PATH", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        await addDepsTemplate(dir);
        const target = path.join(dir, "safe-chained");
        execaMock.mockResolvedValue({ failed: false });

        await executeInit({ dir: target, template: "deps" }, { silent: true });

        // Skip the `safe-chain --version` probe; find the actual install.
        const installCall = execaMock.mock.calls.find(
          ([cmd, args]) => cmd === "safe-chain" && (args as string[]).includes("install"),
        );
        expect(installCall?.[1]).toEqual(
          expect.arrayContaining(["pnpm", "--safe-chain-skip-minimum-package-age", "install"]),
        );
      }),
    );
  });

  test("reports the diagnostics when pnpm install fails", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        await addDepsTemplate(dir);
        const target = path.join(dir, "broken-install");
        execaMock.mockImplementation((cmd: string) =>
          cmd === "pnpm"
            ? Promise.reject(new Error("registry unreachable"))
            : Promise.resolve({ failed: true }),
        );

        const result = await executeInit({ dir: target, template: "deps" }, { silent: true });

        // Both diagnostics ride the RESULT as well as `log.warn`, which JSON
        // mode silences: without them a scripted `aai init` could not tell this
        // outcome from a clean run, both being `{ ok: true }`.
        expect(result).toMatchObject({
          ok: true,
          data: {
            dir: target,
            template: "deps",
            warnings: [
              expect.stringContaining("pnpm install failed: registry unreachable"),
              expect.stringContaining("npm install -g pnpm"),
            ],
          },
        });
      }),
    );
  });

  test("skips the install entirely when node_modules already exists", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        await addDepsTemplate(dir);
        const target = path.join(dir, "preinstalled");
        await fs.mkdir(path.join(target, "node_modules"), { recursive: true });

        await executeInit({ dir: target, template: "deps" }, { silent: true });

        expect(execaMock).not.toHaveBeenCalled();
      }),
    );
  });

  test("scaffolds a project without publishing it", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "my-agent");

        // execa is mocked with no implementation, so the scaffold's install
        // fails — hence the warnings; the files below are what say the scaffold
        // itself ran.
        const result = await executeInit({ dir: target }, { silent: true });

        expect(result).toMatchObject({
          ok: true,
          data: { dir: target, template: "simple" },
        });
        expect(await fileExists(path.join(target, "agent.json"))).toBe(true);
        expect(await fileExists(path.join(target, "shared.txt"))).toBe(true);
        expect(executePublish).not.toHaveBeenCalled();
      }),
    );
  });

  test("picks a template through the selector when --template is omitted", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        await addDepsTemplate(dir);
        const target = path.join(dir, "picked");
        // The author scrolls off the pre-selected default and chooses `deps`.
        selectMock.mockResolvedValueOnce("deps");

        const result = await executeInit({ dir: target });

        expect(selectMock).toHaveBeenCalledTimes(1);
        if (result.ok) expect(result.data.template).toBe("deps");
        // The template's own file, not the scaffold's — the pick reached the copy.
        expect(await fileExists(path.join(target, "agent.json"))).toBe(true);
        expect(await fileExists(path.join(target, "readme.txt"))).toBe(false);
      }),
    );
  });

  test("--yes takes the default template without prompting", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        // A SECOND template, so the assertion below is about the `--yes` guard
        // rather than about promptTemplate's "one choice is not a choice" exit.
        await addDepsTemplate(dir);
        const target = path.join(dir, "yes-mode");

        const result = await executeInit({ dir: target, yes: true });

        expect(selectMock).not.toHaveBeenCalled();
        if (result.ok) expect(result.data.template).toBe("simple");
      }),
    );
  });

  /**
   * JSON mode is AUTO-DETECTED on a pipe and reaches here as `silent`, so a
   * prompt on this path would hang a scripted `aai init | jq` on a terminal
   * read nobody is watching.
   */
  test("silent mode takes the default template without prompting", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        // Two templates, for the same reason as the spec above.
        await addDepsTemplate(dir);
        const target = path.join(dir, "silent-mode");

        const result = await executeInit({ dir: target }, { silent: true });

        expect(selectMock).not.toHaveBeenCalled();
        if (result.ok) expect(result.data.template).toBe("simple");
      }),
    );
  });

  test("refuses to overwrite an existing agent.ts without --force", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "existing");
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "agent.ts"), "// existing agent");

        await expect(executeInit({ dir: target }, { silent: true })).rejects.toThrow(
          "agent.ts already exists",
        );
      }),
    );
  });

  test("--force overwrites an existing project", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "existing");
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "agent.ts"), "// existing agent");

        const result = await executeInit({ dir: target, force: true }, { silent: true });
        expect(result.ok).toBe(true);
        expect(await fileExists(path.join(target, "agent.json"))).toBe(true);
      }),
    );
  });

  /**
   * The regression this file exists to hold: `init` used to publish to
   * production once the install succeeded, so scaffolding a directory reached
   * for credentials the author might not have and shipped a template agent
   * nobody had run. An install that SUCCEEDS is the precondition it used to
   * need, which is why this spec lets it.
   */
  test("never publishes, even when the install succeeds", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "not-deployed");
        execaMock.mockResolvedValue({ failed: false });

        const result = await executeInit({ dir: target }, { silent: true });

        expect(executePublish).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: true, data: { dir: target, template: "simple" } });
      }),
    );
  });

  test("a clean init carries no warnings field at all", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "clean");
        execaMock.mockResolvedValue({ failed: false });

        const result = await executeInit({ dir: target }, { silent: true });

        expect(result).toEqual({ ok: true, data: { dir: target, template: "simple" } });
      }),
    );
  });

  test("a scaffold failure stops the spinner instead of leaking it", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        spinnerCalls.started.length = 0;
        spinnerCalls.stopped.length = 0;

        // No such template: runInit throws inside the spinner's window. The
        // leak this guards is a clack spinner whose interval and raw-mode
        // stdin hook outlive the throw — it is only ever started when the UI
        // is not suppressed, so this runs without `{ silent: true }`.
        await expect(
          executeInit({ dir: path.join(dir, "boom"), template: "no-such-template" }),
        ).rejects.toThrow();

        expect(spinnerCalls.started).toHaveLength(1);
        expect(spinnerCalls.stopped).toEqual([expect.stringContaining("Could not create")]);
      }),
    );
  });
});

describe("patchPackageJsonForWorkspace", () => {
  test("rewrites workspace deps to link: paths", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "my-agent");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@10.29.3",
          dependencies: {
            "@alexkroman1/aai": "^0.12.3",
            "@alexkroman1/aai-ui": "^0.12.3",
            preact: "^10.29.0",
          },
          devDependencies: {
            "@alexkroman1/aai-cli": "^0.12.3",
            vitest: "^4.1.1",
          },
        }),
      );

      await patchPackageJsonForWorkspace(target);

      const result = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
      expect(result.name).toBe("my-agent");
      expect(result.packageManager).toBeUndefined();
      expect(result.dependencies["@alexkroman1/aai"]).toMatch(/^link:/);
      expect(result.dependencies["@alexkroman1/aai"]).toContain("/aai");
      expect(result.dependencies["@alexkroman1/aai-ui"]).toMatch(/^link:/);
      expect(result.dependencies.preact).toBe("^10.29.0");
      expect(result.devDependencies["@alexkroman1/aai-cli"]).toMatch(/^link:/);
      expect(result.devDependencies.vitest).toBe("^4.1.1");
    });
  });

  /**
   * The expected set is DERIVED from the scaffold rather than listed, because
   * the map it checks is hand-kept and the spec above hand-lists the same three
   * names it did — so the two agreed with each other while `aai-runtime`, split
   * out into its own published package, was linked by neither. `aai init` then
   * resolved it from the real npm registry: a 404 before that package's first
   * release, and a stale published copy after it, in a project whose whole
   * point is running against the working tree.
   */
  test("links every @alexkroman1 dependency the scaffold declares", async () => {
    const scaffold = JSON.parse(
      await fs.readFile(
        path.resolve(import.meta.dirname, "../../aai-templates/scaffold/package.json"),
        "utf-8",
      ),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const declared = ["dependencies", "devDependencies"].flatMap((field) =>
      Object.keys(scaffold[field as "dependencies" | "devDependencies"] ?? {}).filter((name) =>
        name.startsWith("@alexkroman1/"),
      ),
    );
    // A floor: an empty list would make every assertion below vacuous, which
    // is the shape of a spec that passes because it stopped measuring.
    expect(declared.length).toBeGreaterThanOrEqual(4);

    await withTempDir(async (dir) => {
      const target = path.join(dir, "my-agent");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, "package.json"),
        JSON.stringify({
          dependencies: scaffold.dependencies,
          devDependencies: scaffold.devDependencies,
        }),
      );

      await patchPackageJsonForWorkspace(target);

      const result = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8")) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      for (const name of declared) {
        const range = result.dependencies[name] ?? result.devDependencies[name];
        expect(range, `${name} must be linked to the working tree`).toMatch(/^link:/);
        // The directory under packages/ is the package name without the scope,
        // so a link pointing at the wrong sibling fails here too.
        expect(range).toContain(`/${name.slice("@alexkroman1/".length)}`);
      }
    });
  });
});

describe("promptTemplate", () => {
  beforeEach(() => {
    selectMock.mockClear();
  });

  test("offers every shipped template, default first and hinted", async () => {
    const picked = await promptTemplate(() =>
      Promise.resolve(["briefing-desk", "pizza-ordering", "simple"]),
    );

    expect(picked).toBe("simple");
    const opts = selectMock.mock.calls[0]?.[0] as {
      initialValue: string;
      options: { value: string; hint?: string }[];
    };
    expect(opts.initialValue).toBe("simple");
    // Hoisted to the top so the pre-selected entry is the one under the cursor,
    // rather than somewhere down a two-dozen-entry scroll.
    expect(opts.options.map((o) => o.value)).toEqual(["simple", "briefing-desk", "pizza-ordering"]);
    expect(opts.options[0]?.hint).toBeTruthy();
    expect(opts.options[1]?.hint).toBeUndefined();
  });

  test("keeps the listed order when the default is not among them", async () => {
    await promptTemplate(() => Promise.resolve(["alpha", "beta"]));

    const opts = selectMock.mock.calls[0]?.[0] as {
      initialValue: string;
      options: { value: string }[];
    };
    expect(opts.initialValue).toBe("alpha");
    expect(opts.options.map((o) => o.value)).toEqual(["alpha", "beta"]);
  });

  test("does not prompt when there is nothing to choose between", async () => {
    expect(await promptTemplate(() => Promise.resolve(["only-one"]))).toBe("only-one");
    // An empty list is a broken install; the error belongs to the copy step,
    // which names the templates it did find.
    expect(await promptTemplate(() => Promise.resolve([]))).toBe("simple");
    expect(selectMock).not.toHaveBeenCalled();
  });
});
