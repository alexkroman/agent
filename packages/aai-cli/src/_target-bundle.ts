// Copyright 2026 the AAI authors. MIT license.
/**
 * Bundling a deployment target's ENTRY into one self-contained ESM file.
 *
 * Shared by every target that emits one, because the reason is the same at
 * each: the entry imports `@alexkroman1/aai-cli/start`, and what a host does
 * with the module graph behind that import differs in ways that are all bad.
 *
 * - **Vercel** traces it with `@vercel/nft`, which cannot follow the dynamic
 *   `import(pathToFileURL(...))` that loads the worker.
 * - **Deno Deploy** caches the dependency graph of the PACKAGE rather than of
 *   the import, and `@alexkroman1/aai-cli`'s dependencies are a build
 *   toolchain — vite, rolldown and the rest. Measured: the build exceeded its
 *   1024 MiB memory limit at "Caching dependencies for the entrypoint" before
 *   it reached any code of ours.
 *
 * A bundle removes the question. The host resolves nothing, installs nothing,
 * and what runs is what the project's own lockfile pinned.
 *
 * ...as long as the bundle really has nothing left to resolve, which is what
 * {@link JSDOC_FREE_COMMENTS} is about — a bundle can carry a dependency it
 * never imports.
 *
 * The entry is written INTO the project rather than a temp directory, because
 * that is what makes `@alexkroman1/aai-cli/start` resolve against the user's
 * install. Removed in a `finally`: a build that throws must not leave a file
 * that looks authored.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { invariant } from "@alexkroman1/aai/internal";
import { build, type Plugin, type Rollup } from "vite";
import { withPreservedNodeEnv } from "./_vite-env.ts";

/**
 * Drop JSDoc from the bundle, and KEEP the other two comment classes.
 *
 * ## A commented `import()` is a real dependency
 *
 * A JSDoc `@type {import(<specifier>).Webidl}` is a comment to every runtime
 * that executes this file and an EDGE in the module graph to every tool that
 * walks it. Deno resolves the specifier out of a JSDoc type position, so a
 * bundle full of third-party JSDoc arrives at Deno Deploy carrying dependencies
 * that were never bundled because nothing imports them.
 *
 * **Every specifier below is written with a `<placeholder>` rather than
 * quoted**, and that is this bug rather than pedantry: spelling them the real
 * way made `pnpm check:knip` fail on THIS file, reporting `selderee` as an
 * unlisted dependency and undici's relative path as an unresolved import — a
 * comment describing the defect reproducing it, in a second graph-walking tool.
 * Keep the placeholders.
 *
 * **Deno Deploy TOLERATES them today, and that is not a reason to ship them.**
 * Measured, because the first version of this comment guessed otherwise and was
 * wrong: a `quickstart-agent` emit carrying all the JSDoc below deployed and
 * served a full voice session, so nothing here is load-bearing for that host.
 * What the phantom edges cost is the property `app.py` states in its own header
 * — "a bundle with no imports left to resolve" — which was false: `deno info`
 * on the emitted entry reported NINE unresolvable specifiers, and after this
 * setting reports zero. Any tool that walks the graph rather than executing it
 * sees them (`deno info`, `deno check`, `@vercel/nft`), and a host that starts
 * enforcing what Deploy currently ignores would present as a build failure with
 * no line of ours in it.
 *
 * Nine phantom specifiers in that bundle, from THREE sources, which is why
 * this is a bundler setting rather than nine fixes:
 * - undici's JSDoc — `../api/api-request`, `../dispatcher/client`,
 *   `../core/request`, `types/dispatcher`, `types/client`, `types/webidl`
 * - html-to-text's — a `@param` naming the `selderee` package, which IS in the
 *   bundle, so the bare specifier resolves nowhere from inside it
 * - **our own SDK's** — an `{@link import(<step-generate-json>)}` in the
 *   workflow docs' prose, the half no dependency bump would ever fix
 *
 * ## Why not `comments: false`
 *
 * `annotation` carries `@__PURE__` and `@__NO_SIDE_EFFECTS__`: those are
 * instructions to the tree-shaker, and dropping them changes what the bundle
 * DOES, not just how it reads. `legal` carries `@license` and `@preserve` from
 * every third-party package in here — stripping those wholesale is a licensing
 * decision and not one a deploy target gets to make quietly. `jsdoc` is the
 * only class that can name a module, so it is the only one that goes.
 *
 * Applied to EVERY target rather than to Deno alone, on this module's own
 * thesis: what a host does with the graph "differs in ways that are all bad",
 * and a phantom edge is a hazard to any host that walks one — `@vercel/nft`
 * traces imports too. One bundler, one behaviour.
 *
 * @see https://docs.deno.com/runtime/reference/cli/info — `deno info` resolves
 * the graph instead of executing it, which is why it is the gate and why
 * booting the emitted directory is not.
 */
export const JSDOC_FREE_COMMENTS = { legal: true, annotation: true, jsdoc: false } as const;

/**
 * The `node:` builtins an emitted deployment may import.
 *
 * ## Why an ALLOWLIST rather than a note in a guide
 *
 * `ssr.noExternal` bundles everything except these, so whatever survives the
 * pass is a hard dependency on the runtime the host chose — and the emitted
 * directory is a container payload whose runtime is the operator's choice, not
 * ours (`_target-entry.ts` carries that argument). Every name here is
 * implemented by `node`, `deno` and `bun` alike, so the deployment behaves the
 * same under all three.
 *
 * What it is written for is the class the boot arms in
 * `_target-runtimes.scenario.test.ts` cannot see. A dependency bump that drags
 * `node:vm`, `node:cluster` or `node:v8` into the graph reaches a runtime that
 * half-implements it not at boot but at the first CALL — which is a live
 * session, days after the deploy, with nothing in CI to have caught it. This
 * suite reads the bundle instead, so it fails on the build that introduced it.
 * (`node:vm` is a real risk rather than a hypothetical: `aai-runtime`'s
 * `eval/vm-run-code.ts` uses it, and it stays out of the deployment only
 * because nothing in the boot graph reaches that subpath.)
 *
 * ADDING a name is a claim about three runtimes, so check all three rather
 * than the one you are on — `node:worker_threads` is here because Bun and Deno
 * both ship it, `node:cluster` is not because Bun does not.
 */
export const PORTABLE_NODE_BUILTINS: readonly string[] = [
  "diagnostics_channel",
  "dns/promises",
  "util/types",
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "console",
  "crypto",
  "dns",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "worker_threads",
  "zlib",
];

/**
 * Builtins the bundle NAMES but never requires — each behind a runtime feature
 * test, and each therefore free to be absent.
 *
 * A second list rather than more entries in the first, because the two carry
 * different claims and collapsing them would state the wrong one. A name above
 * is portable: all three runtimes implement it, so the code that imports it
 * runs everywhere. A name here is not — `node:sqlite` is Node-only, Deno does
 * not ship it — and what makes it harmless is the GUARD, not the support.
 *
 * `sqlite` is undici's, twice over: `detectRuntimeFeatureByNodeModule` loads it
 * inside a `try` that tolerates `ERR_UNKNOWN_BUILTIN_MODULE`, and
 * `SqliteCacheStore` requires it lazily in a constructor nothing here calls.
 *
 * The spec pins the guard rather than trusting this comment: a name here must
 * never appear as a STATIC import in the bundle, which is what would make it a
 * load-time dependency again.
 */
export const FEATURE_DETECTED_NODE_BUILTINS: readonly string[] = ["sqlite"];

/** undici's webidl module, whose one unguarded line the plugin below repairs. */
const UNDICI_WEBIDL = "undici/lib/web/webidl/index.js";

/** The line as undici 8.10.1 writes it, and as this plugin requires it to still be. */
const UNDICI_MARK = "const { markAsUncloneable } = require('node:worker_threads')";

/**
 * Give undici's `markAsUncloneable` a fallback, so the emitted bundle BOOTS
 * under Bun.
 *
 * ## The failure, measured
 *
 * undici assigns `webidl.util.markAsUncloneable = markAsUncloneable` with no
 * guard, destructured from `node:worker_threads`. Node has had that symbol
 * since 21; **Bun's `node:worker_threads` does not implement it**, so the
 * property is `undefined`, and undici's own `CacheStorage` calls it in its
 * constructor at module scope. The emitted server therefore died on IMPORT
 * under `bun ./server.mjs`:
 *
 *     TypeError: webidl.util.markAsUncloneable is not a function
 *       at new CacheStorage (server.mjs:33500)
 *
 * A destructuring default is the whole repair (`= () => {}`), and the fallback
 * costs nothing where the symbol exists: it marks objects as non-cloneable for
 * `postMessage`, and nothing in this deployment posts a `CacheStorage` to a
 * worker. Verified both ways — with the patch, Bun boots the emit and serves
 * `/health`, `/client-config` and `/`; without it, neither.
 *
 * ## Why a plugin rather than an alias on the builtin
 *
 * The alternative is aliasing `node:worker_threads` to a shim that re-exports
 * the builtin plus a fallback. That shim's own import of the builtin resolves
 * through the same alias, so it either recurses or needs a second escape
 * specifier — and it would reroute the builtin for every consumer in the
 * bundle to fix one line in one of them. This is the narrow tool: one file, one
 * string.
 *
 * ## It FAILS the build rather than silently not applying
 *
 * A pinned string is only load-bearing while it matches. If undici's webidl
 * module is in the graph and the line is not, the pattern has moved and the
 * emit would go out crashing under Bun with nothing to say so — so the build
 * stops and names the file to look at. A graph that never reaches undici is not
 * an error; nothing was there to patch.
 */
function guardUndiciMarkAsUncloneable(): Plugin {
  let seen = false;
  let patched = false;
  return {
    name: "aai:guard-undici-mark-as-uncloneable",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith(UNDICI_WEBIDL)) return null;
      seen = true;
      if (!code.includes(UNDICI_MARK)) return null;
      patched = true;
      return {
        code: code.replace(
          UNDICI_MARK,
          "const { markAsUncloneable = () => {} } = require('node:worker_threads')",
        ),
        map: null,
      };
    },
    buildEnd() {
      if (!seen || patched) return;
      throw new Error(
        `${UNDICI_WEBIDL} is in the bundle but no longer contains\n  ${UNDICI_MARK}\n` +
          "so the Bun boot guard did not apply. Re-read that file: if undici now " +
          "guards the assignment itself, delete this plugin and its spec; if the line " +
          "merely moved, update UNDICI_MARK. Shipping unpatched crashes the emit on " +
          "import under Bun.",
      );
    },
  };
}

/** Bundle `source` as if it were a module in `cwd`, and answer the code. */
export async function bundleTargetEntry(
  cwd: string,
  source: string,
  name: string,
): Promise<string> {
  const entryPath = path.join(cwd, ".aai", `${name}-entry.mjs`);
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.writeFile(entryPath, source, "utf-8");

  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await withPreservedNodeEnv(() =>
      build({
        root: cwd,
        logLevel: "silent",
        configFile: false,
        // One plugin, for one upstream line — see the function's own doc.
        plugins: [guardUndiciMarkAsUncloneable()],
        // Bundle everything except `node:` builtins — see this module's doc.
        ssr: { noExternal: true },
        build: {
          ssr: true,
          lib: { entry: entryPath, formats: ["es"], fileName: name },
          target: "node20",
          minify: false,
          write: false,
          rollupOptions: {
            // One file: a host loads the entry and nothing resolves a sibling
            // chunk relative to it.
            output: {
              entryFileNames: "[name].mjs",
              codeSplitting: false,
              // A commented `import()` is an edge in the module graph — see
              // `JSDOC_FREE_COMMENTS`.
              comments: JSDOC_FREE_COMMENTS,
            },
          },
        },
      }),
    );
  } finally {
    await fs.rm(entryPath, { force: true }).catch(() => undefined);
  }

  const output = Array.isArray(result) ? result[0] : (result as Rollup.RollupOutput);
  invariant(output !== undefined, "target.entry.output", () => ({ name }));
  const chunk = output.output.find((o): o is Rollup.OutputChunk => o.type === "chunk" && o.isEntry);
  invariant(chunk !== undefined, "target.entry.chunk", () => ({
    name,
    kinds: output.output.map((o) => o.type),
  }));
  return chunk.code;
}

/** Whether a path exists — the check every emit makes of an optional file. */
export async function targetPathExists(target: string): Promise<boolean> {
  return await fs.stat(target).then(
    () => true,
    () => false,
  );
}
