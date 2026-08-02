// Copyright 2026 the AAI authors. MIT license.
/**
 * The build child — the ONLY place the bundler toolchain is imported.
 *
 * Spawned as `node <harness entry> --build-workspace <dir> --out <dir>
 * [--worker] [--client]` by `buildWorkspaceDir`, this runs the typecheck gate
 * and the aai CLI's own bundlers, writes the artifacts into the scratch `out`
 * directory, prints a one-line JSON envelope on stdout, and exits. Exiting is
 * the point: Rolldown bundles in Rust, outside V8, and never gives that
 * memory back — see studio-build.ts's header for the measurements. Keep every
 * `@alexkroman1/aai-cli/*-bundler`, `@vitejs/plugin-react`, and
 * `@tailwindcss/vite` import inside this module.
 *
 * Diagnostics are formatted HERE rather than in the parent, because the
 * formatting needs the workspace dir and its resolvable modules — the parent
 * receives prose the coding agent can act on and nothing it must post-process.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type BuildEnvelope, formatBuildFailure, moduleExports, scrubDir } from "./studio-build.ts";
import { annotateDiagnostics } from "./studio-diagnostics.ts";

type Toolchain = {
  buildWorker: (cwd: string, opts: { minify?: boolean; configFile?: false }) => Promise<string>;
  buildClient: (
    cwd: string,
    opts: { configFile?: false; plugins?: unknown[] },
  ) => Promise<Record<string, string>>;
  clientPlugins: () => unknown[];
  typecheckProject: (
    cwd: string,
  ) => Promise<{ ok: true; skipped: boolean } | { ok: false; output: string }>;
};

async function loadToolchain(): Promise<Toolchain> {
  const [worker, client, typecheck, react, tailwind] = await Promise.all([
    import("@alexkroman1/aai-cli/worker-bundler"),
    import("@alexkroman1/aai-cli/client-bundler"),
    import("@alexkroman1/aai-cli/typecheck"),
    import("@vitejs/plugin-react"),
    import("@tailwindcss/vite"),
  ]);
  return {
    buildWorker: worker.buildWorker,
    buildClient: client.buildClient as Toolchain["buildClient"],
    // Fresh plugin instances per build — Vite plugins are stateful.
    clientPlugins: () => [react.default(), tailwind.default()],
    typecheckProject: typecheck.typecheckProject,
  };
}

/** `--flag value` lookup over the child's own argv tail. */
function argValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * Build the workspace named in `args` and write the artifacts to `--out`.
 *
 * `configFile: false` on both passes: a studio workspace has no
 * `vite.config.ts` (the scaffold's plugins are injected here instead), and
 * one the coding agent invents must not change how Publish builds.
 */
async function build(args: string[]): Promise<BuildEnvelope> {
  const dir = argValue(args, "--build-workspace");
  const out = argValue(args, "--out");
  if (!(dir && out)) {
    return { ok: false, buildError: "build child requires --build-workspace <dir> --out <dir>" };
  }

  let tc: Toolchain;
  try {
    tc = await loadToolchain();
  } catch (err) {
    return { ok: false, buildError: `Build toolchain unavailable in this sandbox: ${msg(err)}` };
  }

  // Type errors first, as their own failure: the bundlers strip types
  // unchecked, so this is the only gate that catches runtime-working-but-
  // wrong code — and the message is exactly what the coding agent needs.
  const typed = await tc.typecheckProject(dir);
  if (!typed.ok) {
    // Attach the fixing idiom to the diagnostic rather than carrying it in
    // the system prompt: it costs nothing until a build actually fails, and
    // it arrives inside the error the agent is already reading.
    return {
      ok: false,
      buildError: annotateDiagnostics(scrubDir(typed.output, dir), moduleExports(dir)),
    };
  }

  const wantWorker = args.includes("--worker");
  const wantClient = args.includes("--client");
  try {
    const [worker, clientFiles] = await Promise.all([
      wantWorker ? tc.buildWorker(dir, { minify: true, configFile: false }) : undefined,
      wantClient
        ? tc.buildClient(dir, { configFile: false, plugins: tc.clientPlugins() })
        : undefined,
    ]);
    if (worker !== undefined) await writeFile(path.join(out, "worker.mjs"), worker, "utf-8");
    if (clientFiles !== undefined) {
      await writeFile(path.join(out, "client.json"), JSON.stringify(clientFiles), "utf-8");
    }
    return {
      ok: true,
      ...(worker !== undefined && { worker: true }),
      ...(clientFiles !== undefined && { client: true }),
    };
  } catch (err) {
    return { ok: false, buildError: formatBuildFailure(err, dir) };
  }
}

/**
 * Child entry point: build, print the envelope, exit.
 *
 * The exit rides stdout's flush callback — stdout is a pipe here, so its
 * writes are asynchronous and `process.exit()` on the next line would
 * truncate the envelope the parent is parsing.
 */
export async function runBuildChild(args: string[]): Promise<void> {
  let envelope: BuildEnvelope;
  try {
    envelope = await build(args);
  } catch (err) {
    // A throw here would exit non-zero with no envelope, which the parent
    // can only report as a crash; an envelope is strictly more useful.
    envelope = { ok: false, buildError: `Build failed: ${msg(err)}` };
  }
  process.stdout.write(`${JSON.stringify(envelope)}\n`, () => {
    process.exit(envelope.ok ? 0 : 1);
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
