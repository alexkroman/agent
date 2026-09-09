#!/usr/bin/env node

/**
 * Every npm package INLINED into the service entry, against a committed
 * baseline. Only ever lowered.
 *
 * `aai-studio-server`'s entry compiles `aai-server` in (see that package's
 * tsdown.config.ts for why), and tsdown externalizes only what the entry's own
 * manifest declares — so every dependency of the bundled package that the entry
 * does not declare is SWALLOWED into `dist/index.mjs`. There were 52 of them,
 * and nothing in the repo named one.
 *
 * ## The failure that is worth a gate
 *
 * A swallowed module does not run from where its source lives, so anything in
 * it that resolves by module location breaks — silently, because the build
 * succeeds, tsc is happy, and the module still evaluates.
 *
 * It shipped. `@alexkroman1/aai-ui` was one of the 52, so `client-dir.ts` was
 * inlined here, and `defaultClientDir()` finds the browser client by
 * self-referencing `@alexkroman1/aai-ui/package.json` — which Node permits only
 * from inside that package. Every deployed agent page answered 500 with "Could
 * not locate the default client UI — is @alexkroman1/aai-ui installed?" on a
 * platform where it plainly was.
 *
 * That one was fixed by not resolving it from a bundled package at all
 * (`createDefaultClientHandlers` takes the directory), and the next one cannot
 * be: `node-gyp-build-optional-packages`, `detect-libc`, `cbor-extract`,
 * `protobufjs` and `@grpc/proto-loader` all read files relative to their own
 * package, and nobody can inject into them. They are external now (`modal` is,
 * and they are its tree), as is `microsandbox`, whose `resolve-binary.js`
 * locates a native addon from `import.meta.url` — a live dynamic-import path in
 * shipped code, and the same bug waiting.
 *
 * So the remaining set is deliberate: pure-JS packages where inlining is free
 * and buys a smaller graph at container cold start. This gate makes a 26th an
 * explicit decision instead of a discovery in production.
 *
 * ## Why it RUNS the build
 *
 * The list is tsdown's own answer (its `Detected dependencies in bundle` hint),
 * not a re-derivation from manifests. A static walk of the lockfile would
 * over-approximate — rolldown inlines what is actually imported, not what is
 * declared — and a gate whose set disagrees with the real bundle is worse than
 * no gate. The build is ~1.5s and turbo has usually cached it already, which is
 * also why this sits in the `after-build` phase rather than with the ratchets.
 *
 * An ABSENT hint is a hard failure, never an empty set. tsdown prints it only
 * while `deps.alwaysBundle` is in use — set `deps.onlyBundle` instead and the
 * hint disappears, which would leave this gate agreeing with anything. That is
 * the same vacuous-parse trap every gate spec in `packages/aai-gates` carries a
 * floor against, and `bundled-deps.test.ts` holds the config to `alwaysBundle`
 * from the other side.
 *
 * Usage: `node scripts/check-bundled-deps.mjs [--update]`
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScriptArgs } from "./_args.mjs";

// Parsed STRICTLY, never scanned: `--update` REWRITES the committed baseline,
// so a misspelled flag that read as absent would be the safe direction here and
// a wrapper that swallowed it would silently verify against a file it had just
// overwritten. `guard-invariants` rule 28 carries the six gates that shipped
// that bug.
const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { update: { type: "boolean" } },
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(REPO_ROOT, "scripts", "bundled-deps-baseline.json");

const GREEN = "\u001b[0;32m";
const RED = "\u001b[0;31m";
const NC = "\u001b[0m";

/** The entry whose bundle this describes — one deployment, one entry. */
const PACKAGE = "aai-studio-server";

/**
 * Every package name tsdown reports as inlined.
 *
 * Parsed from the hint block rather than from the bundle bytes: a minified
 * bundle no longer names the packages it swallowed, which is the whole
 * difficulty — that is why the hint exists and why it is the source here.
 *
 * @param {string} output Combined stdout+stderr of the build.
 * @returns {string[] | null} Sorted names, or null when the hint is absent.
 */
function parseSwallowed(output) {
  const start = output.indexOf("Detected dependencies in bundle");
  if (start === -1) return null;
  /** @type {string[]} */
  const names = [];
  for (const line of output.slice(start).split("\n").slice(1)) {
    // No ANSI stripping: the build below runs with FORCE_COLOR=0, so the hint
    // arrives plain (verified). If a future tsdown colourises it anyway, this
    // matches nothing and the empty-set guard below FAILS — which is the right
    // direction for a gate, and better than carrying an escape sequence in a
    // pattern to make it silently keep working.
    const m = /^-\s+(\S+)\s*$/.exec(line);
    // The block ends at the first line that is not a `- <name>` entry.
    if (!m) break;
    names.push(/** @type {string} */ (m[1]));
  }
  return names.sort();
}

const build = spawnSync("pnpm", ["--filter", PACKAGE, "build"], {
  cwd: REPO_ROOT,
  encoding: "utf-8",
  env: { ...process.env, FORCE_COLOR: "0" },
});
if (build.status !== 0) {
  console.error(`${RED}check-bundled-deps: \`pnpm --filter ${PACKAGE} build\` failed.${NC}`);
  console.error(build.stdout ?? "");
  console.error(build.stderr ?? "");
  process.exit(1);
}

const swallowed = parseSwallowed(`${build.stdout ?? ""}\n${build.stderr ?? ""}`);
if (swallowed === null || swallowed.length === 0) {
  console.error(
    `${RED}check-bundled-deps: tsdown printed no "Detected dependencies in bundle" hint.${NC}\n\n` +
      "This gate cannot see an empty set as good news — an unparsed hint and a bundle\n" +
      "that swallows nothing look identical from here, and the second one is not what\n" +
      `happened. The usual cause is \`deps.onlyBundle\` in packages/${PACKAGE}/tsdown.config.ts:\n` +
      "it suppresses the hint AND externalizes aai-server itself, which is the cold-start\n" +
      "regression that config's own comment documents. Restore `deps.alwaysBundle`.",
  );
  process.exit(1);
}

/** @type {{ inlined: string[] }} */
const baseline = JSON.parse(readFileSync(BASELINE, "utf-8"));
const expected = [...baseline.inlined].sort();

if (FLAGS.update === true) {
  const next = JSON.stringify({ ...baseline, inlined: swallowed }, null, 2);
  writeFileSync(BASELINE, `${next}\n`);
  console.log(`check-bundled-deps: baseline updated — ${swallowed.length} inlined package(s). ✓`);
  process.exit(0);
}

const added = swallowed.filter((n) => !expected.includes(n));
const removed = expected.filter((n) => !swallowed.includes(n));

if (added.length > 0) {
  console.error(
    `${RED}check-bundled-deps: ${added.length} package(s) newly INLINED into ` +
      `packages/${PACKAGE}/dist/index.mjs:${NC}\n\n` +
      added.map((n) => `  + ${n}`).join("\n") +
      "\n\nA swallowed module does not run from where its source lives, so anything in it\n" +
      "that resolves by module location — a native addon, a `.proto` or data file read\n" +
      "relative to its own package, a `require.resolve` of its own manifest — breaks in\n" +
      "production while the build, tsc and the test suite all stay green. That is how\n" +
      "every deployed agent page came to answer 500 for the default client UI.\n\n" +
      "Decide, rather than inherit:\n" +
      "  • location-independent pure JS → run `node scripts/check-bundled-deps.mjs --update`\n" +
      "    and say why in the commit.\n" +
      "  • reads anything off disk → add it, or its ROOT (which takes its whole tree with\n" +
      `    it), to \`external\` in packages/${PACKAGE}/tsdown.config.ts, and DECLARE it in that\n` +
      "    package so the specifier still resolves from `dist/`.",
  );
  process.exit(1);
}

if (removed.length > 0) {
  console.error(
    `${RED}check-bundled-deps: the baseline is STALE — ${removed.length} package(s) ` +
      `no longer inlined:${NC}\n\n` +
      removed.map((n) => `  - ${n}`).join("\n") +
      "\n\nGood news, and it has to be recorded or it creeps back unnoticed. Run\n" +
      "`node scripts/check-bundled-deps.mjs --update`. This baseline only ever goes down.",
  );
  process.exit(1);
}

console.log(
  `${GREEN}check-bundled-deps: ${swallowed.length} inlined package(s), all baselined. ✓${NC}`,
);
