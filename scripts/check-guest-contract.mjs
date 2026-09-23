#!/usr/bin/env node

/**
 * The deployed-guest contract, held to `GUEST_CONTRACT_VERSION` the way a
 * capability is held to its epoch.
 *
 * ## The drift this closes
 *
 * An agent sandbox runs the harness image PINNED at deploy time, so a platform
 * server is routinely NEWER than the guest it spawns. What the two agree on is
 * small and is written down in `aai-guest-core/src/limits.ts`: the exec-env boot
 * convention the server writes (`agentBootEnv` in `aai-server/guest/boot-env.ts`),
 * the token-gated `/manage/*` HTTP surface the guest serves
 * (`aai-guest/harness/manage.ts`), and the harness↔bundle handshake
 * (`CreateGuestRuntime` / `GuestRuntime` in `aai-guest-core/src/types.ts`).
 * `GUEST_CONTRACT_VERSION` is the number, and its doc comment is the changelog —
 * v2 is the case that shows why it matters: an additive key a v1 harness could
 * not boot with, and a host-side image comparison written because of it.
 *
 * Until this gate the number was bumped by MEMORY. Nothing tied it to the
 * surface it versions, so a key added to `agentBootEnv`, a `/manage` path
 * renamed, or a field made required on `GuestRuntime` compiled on both sides of
 * the repo, passed every test (both sides are built from one commit in CI), and
 * met its first older guest in production. The same shape as a published
 * signature moving under an unchanged epoch, which is what `check:api-contracts`
 * exists to refuse — so this is that mechanism, cut down to one contract whose
 * two ends ship on different schedules.
 *
 * ## What it does
 *
 * Extracts the three surfaces by PARSING the files (oxc, the same parser
 * `guard-invariants` uses), hashes a normalized rendering, and compares against
 * `scripts/guest-contract.json`:
 *
 *   - same version, same hash — pass.
 *   - hash moved, version did not — FAIL, naming what moved. Bump
 *     `GUEST_CONTRACT_VERSION`, extend its doc comment, and record the reason
 *     with `--record "<reason>"`. A change a pinned guest genuinely cannot
 *     observe (a type rename that erases to the same JSON, say) can be recorded
 *     as a REVISION of the same version with `--revise "<reason>"` — the escape
 *     hatch is allowed, but it is written down, which is the whole point.
 *   - version moved, record did not — FAIL until `--record` writes it down.
 *
 * Every `--record` / `--revise` appends to `history` and never rewrites it, so
 * "when did the guest contract change, and what did we say" is answerable from
 * the tree — and `pnpm debt:report` reads it back beside the epoch churn.
 *
 * Comments are stripped before hashing: a doc edit is not a contract change, and
 * a hash that moved for one would EXTRACT a reason rather than record one (the
 * argument `_api-contracts-hash.mjs` makes for the rollup preamble).
 *
 * ## Floors
 *
 * Each extraction carries a floor, because an extractor that stopped matching
 * produces an empty surface, a stable hash and a checkmark — the failure shape
 * `.agents/ratchets.md` records this repo paying for repeatedly.
 *
 * Wired up as `pnpm check:guest-contract`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJson } from "./_api-contracts-tree.mjs";
import { parseScriptArgs } from "./_args.mjs";
import { parseSource, walk } from "./_ast-scan.mjs";
import { repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url);
const RECORD_PATH = join(ROOT, "scripts/guest-contract.json");

const FILES = {
  version: "packages/aai-guest-core/src/limits.ts",
  bootEnv: "packages/aai-server/src/guest/boot-env.ts",
  manage: "packages/aai-guest/src/harness/manage.ts",
  types: "packages/aai-guest-core/src/types.ts",
};

/** The harness↔bundle handshake — the type aliases whose text is hashed. */
const HANDSHAKE_TYPES = ["CreateGuestRuntime", "GuestRuntime"];

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { record: { type: "string" }, revise: { type: "string" } },
});

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** Strip comments and collapse whitespace, so only the declaration is hashed. */
function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}();:,|?<>=[\]])\s*/g, "$1")
    .trim();
}

/** A property's static key name, or undefined for a computed / spread one. */
function keyName(prop) {
  if (prop?.type !== "Property" || prop.computed === true) return;
  if (prop.key?.type === "Identifier") return prop.key.name;
  if (prop.key?.type === "Literal" && typeof prop.key.value === "string") return prop.key.value;
}

/** The first function declaration named `name`, wherever it sits. */
function findFunction(program, name) {
  let found;
  walk(program, (node) => {
    if (found !== undefined) return false;
    if (node.type === "FunctionDeclaration" && node.id?.name === name) found = node;
  });
  return found;
}

/** The string elements of `export const NAME = [ … ] as const`. */
function constStringArray(program, name) {
  const out = [];
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.name !== name) return;
    let init = node.init;
    while (init?.type === "TSAsExpression" || init?.type === "TSSatisfiesExpression") {
      init = init.expression;
    }
    for (const el of init?.elements ?? []) {
      if (el?.type === "Literal" && typeof el.value === "string") out.push(el.value);
    }
  });
  return out;
}

/** Every exec-env key `agentBootEnv` can write, plus the OTel keys it forwards. */
function bootEnvKeys() {
  const source = read(FILES.bootEnv);
  const program = parseSource(FILES.bootEnv, source);
  const fn = findFunction(program, "agentBootEnv");
  if (fn === undefined) fail(`${FILES.bootEnv} no longer declares \`function agentBootEnv\`.`);
  const keys = new Set();
  walk(fn.body, (node) => {
    if (node.type !== "ObjectExpression") return;
    for (const prop of node.properties) {
      const name = keyName(prop);
      if (name?.startsWith("AAI_")) keys.add(name);
    }
  });
  for (const key of constStringArray(program, "OTEL_GUEST_ENV_KEYS")) keys.add(key);
  return [...keys].sort();
}

/**
 * The `/manage/*` surface: each path constant's value, and every response key
 * the handler writes.
 */
function manageSurface() {
  const source = read(FILES.manage);
  const program = parseSource(FILES.manage, source);
  const paths = [];
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator") return;
    if (!/^MANAGE_[A-Z_]+_PATH$/.test(node.id?.name ?? "")) return;
    if (node.init?.type === "Literal" && typeof node.init.value === "string") {
      paths.push(node.init.value);
    }
  });
  const handler = findFunction(program, "createManageHandler");
  if (handler === undefined) {
    fail(`${FILES.manage} no longer declares \`function createManageHandler\`.`);
  }
  const responseKeys = new Set();
  walk(handler.body, (node) => {
    if (node.type !== "ObjectExpression") return;
    for (const prop of node.properties) {
      const name = keyName(prop);
      if (name !== undefined) responseKeys.add(name);
    }
  });
  return { paths: paths.sort(), responseKeys: [...responseKeys].sort() };
}

/** The handshake aliases, as normalized declaration text keyed by name. */
function handshakeTypes() {
  const source = read(FILES.types);
  const program = parseSource(FILES.types, source);
  const out = {};
  walk(program, (node) => {
    if (node.type !== "TSTypeAliasDeclaration") return;
    const name = node.id?.name;
    if (HANDSHAKE_TYPES.includes(name)) out[name] = normalize(source.slice(node.start, node.end));
  });
  return out;
}

/** `export const GUEST_CONTRACT_VERSION = <n>;` */
function sourceVersion() {
  const source = read(FILES.version);
  const program = parseSource(FILES.version, source);
  let version;
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id?.name !== "GUEST_CONTRACT_VERSION") return;
    if (node.init?.type === "Literal" && typeof node.init.value === "number") {
      version = node.init.value;
    }
  });
  if (version === undefined) {
    fail(`${FILES.version} no longer declares \`GUEST_CONTRACT_VERSION\` as a number literal.`);
  }
  return version;
}

function fail(message) {
  console.error(`check-guest-contract: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Extract, floor, hash.
// ---------------------------------------------------------------------------

const surface = { bootEnv: bootEnvKeys(), manage: manageSurface(), types: handshakeTypes() };

// Floors, set under today's counts (12 boot keys incl. OTel, 3 paths, 2 types).
// A floor is only ever a guard against a blind extractor, not a target.
const floors = [
  [surface.bootEnv.filter((k) => k.startsWith("AAI_")).length >= 8, "fewer than 8 AAI_* boot keys"],
  [surface.bootEnv.filter((k) => k.startsWith("OTEL_")).length >= 5, "fewer than 5 OTEL_* keys"],
  [surface.manage.paths.length >= 3, "fewer than 3 /manage paths"],
  [surface.manage.responseKeys.includes("contractVersion"), "no `contractVersion` response key"],
  [HANDSHAKE_TYPES.every((t) => surface.types[t] !== undefined), "a handshake type is missing"],
];
for (const [ok, what] of floors) {
  if (!ok) {
    fail(
      `the extraction found ${what}. Either the surface really shrank — which is itself a ` +
        "contract change a pinned guest can observe — or an extractor stopped matching the " +
        "code's shape. Read the file before lowering a floor.",
    );
  }
}

const sha256 = createHash("sha256").update(JSON.stringify(surface)).digest("hex");
const version = sourceVersion();
const record = JSON.parse(readFileSync(RECORD_PATH, "utf8"));

// ---------------------------------------------------------------------------
// --record / --revise: write the decision down. Append-only history.
// ---------------------------------------------------------------------------

const reason = FLAGS.record ?? FLAGS.revise;
if (FLAGS.record !== undefined && FLAGS.revise !== undefined) {
  fail("pass one of --record or --revise, not both.");
}
if (reason !== undefined) {
  if (reason.trim() === "") fail("a reason is required — it is what a future reader reads.");
  if (sha256 === record.sha256 && version === record.version) {
    fail("nothing to record: the surface and the version both match the committed record.");
  }
  if (FLAGS.record !== undefined && version <= record.version) {
    fail(
      `--record needs GUEST_CONTRACT_VERSION raised past ${record.version} (it is ${version}). ` +
        "For a change a pinned guest cannot observe, use --revise instead.",
    );
  }
  if (FLAGS.revise !== undefined && version !== record.version) {
    fail("--revise records a change UNDER the current version; the version moved, so --record it.");
  }
  const priorRevisions = record.history.filter((h) => h.version === version).length;
  const next = {
    ...record,
    version,
    sha256,
    surface,
    history: [
      ...record.history,
      { version, revision: FLAGS.revise === undefined ? 0 : priorRevisions, sha256, reason },
    ],
  };
  writeJson(RECORD_PATH, next);
  console.log(
    `check-guest-contract: recorded guest contract v${version} (${sha256.slice(0, 12)}).`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

/** What moved between the committed surface and this tree, in words. */
function describeDrift(before, after) {
  const lines = [];
  const setDiff = (label, a = [], b = []) => {
    const added = b.filter((x) => !a.includes(x));
    const removed = a.filter((x) => !b.includes(x));
    if (added.length > 0) lines.push(`  + ${label}: ${added.join(", ")}`);
    if (removed.length > 0) lines.push(`  - ${label}: ${removed.join(", ")}`);
  };
  setDiff("boot env key", before?.bootEnv, after.bootEnv);
  setDiff("/manage path", before?.manage?.paths, after.manage.paths);
  setDiff("/manage response key", before?.manage?.responseKeys, after.manage.responseKeys);
  for (const name of HANDSHAKE_TYPES) {
    if (before?.types?.[name] !== after.types[name]) lines.push(`  ~ type ${name} changed`);
  }
  return lines.length > 0
    ? lines.join("\n")
    : "  (no field-level difference — the hash input changed shape)";
}

if (version < record.version) {
  fail(
    `GUEST_CONTRACT_VERSION is ${version} but ${record.version} is recorded. A version never goes ` +
      "back: guests pinned at the higher number already exist.",
  );
}

if (version === record.version && sha256 !== record.sha256) {
  console.error(
    `check-guest-contract: the deployed-guest contract changed under v${version}:\n\n` +
      `${describeDrift(record.surface, surface)}\n\n` +
      "Agent sandboxes run the harness PINNED at deploy time, so the platform must keep\n" +
      "serving guests that predate this change. Bump GUEST_CONTRACT_VERSION in\n" +
      `${FILES.version}, extend its doc comment with what an older guest does, and run:\n\n` +
      '  node scripts/check-guest-contract.mjs --record "<what changed and why an older guest is fine>"\n\n' +
      "If a pinned guest genuinely cannot observe the change, record it as a revision instead:\n\n" +
      '  node scripts/check-guest-contract.mjs --revise "<why no guest can tell>"\n',
  );
  process.exit(1);
}

if (version > record.version) {
  console.error(
    `check-guest-contract: GUEST_CONTRACT_VERSION is ${version} but the record stops at ` +
      `${record.version}. Write the reason down:\n\n` +
      '  node scripts/check-guest-contract.mjs --record "<what changed and why an older guest is fine>"\n',
  );
  process.exit(1);
}

console.log(
  `check-guest-contract: guest contract v${version} matches its record ` +
    `(${surface.bootEnv.length} boot keys, ${surface.manage.paths.length} /manage paths, ` +
    `${HANDSHAKE_TYPES.length} handshake types). ✓`,
);
