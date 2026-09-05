// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `scripts/check-deploy-changeset.mjs` — the gate that a branch changing code
 * the PLATFORM DEPLOY carries also ships it.
 *
 * The gate exists because `changeset status` is satisfied by an EMPTY changeset,
 * so a branch could rewrite the platform, pass every other gate, merge, and
 * ship nothing (#1341). Which makes this spec the usual shape for this
 * directory: the gate's whole success output is a COUNT, so a scope that stopped
 * matching prints the same checkmark as a healthy branch. Two things are
 * therefore asserted that no amount of reading would catch — that the predicate
 * really does exclude a test file and really does include a shipped one, and
 * that `DEPLOY_CARRIED` still names packages that exist.
 *
 * The decisions are VALUE-imported from `scripts/_deploy-changeset-scope.mjs`
 * rather than scraped out of the gate's source, for the reason
 * `guard-invariants-gate.test.ts` records against itself: its own third draft
 * regex-scraped the rules, they moved into a module, and every per-rule
 * assertion went vacuous while still printing green. That module imports
 * nothing, which is what makes the import legal from a package whose tsconfig
 * has no node types.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING, numericConstant, repoPathOf, sole } from "./_gate-support.ts";

const script = sole(
  import.meta.glob("../../../scripts/check-deploy-changeset.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const workflow = sole(
  import.meta.glob<string>("../../../.github/workflows/ship.yml", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** The gate's real decisions, imported rather than re-derived. */
const scope = sole(
  import.meta.glob<{
    DEPLOY_CARRIED: string[];
    DEPLOY_CARRIERS: string[];
    SCHEMA_DIR: string;
    CARRIED_PREFIXES: readonly (readonly [string, string])[];
    isShippedSource: (path: string) => boolean;
    triggeringFiles: (changed: readonly string[]) => Map<string, string[]>;
    namedCarriers: (entries: readonly { name: string }[]) => string[];
  }>("../../../scripts/_deploy-changeset-scope.mjs", { eager: true }),
);

/** Every migration filename, from the real directory. */
const migrationFiles = Object.keys(
  import.meta.glob("../../../supabase/migrations/*.sql", { query: "?raw" }),
);

/**
 * Every directory under `packages/`, from its manifest.
 *
 * Only the KEYS are read, so these are lazy imports nothing ever calls — the
 * same trick the sibling specs use to enumerate the tree without loading it.
 */
const workspaceDirs = new Set(
  Object.keys(import.meta.glob("../../*/package.json")).map(
    (path) => repoPathOf(path).split("/")[1] ?? "",
  ),
);

describe("the gate is wired where it is enforced", () => {
  test("both runner files name it", () => {
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:deploy-changeset`).toContain(
        "check:deploy-changeset",
      );
    }
  });

  test("it fails the process rather than only reporting", () => {
    // `check.mjs` and the CI step both key on the exit status alone, so a gate
    // that printed its findings and exited 0 would be decorative.
    expect(script).toContain("process.exit(1)");
  });

  test("it declares its corpus floor", () => {
    expect(script).toBeTypeOf("string");
    const floor = numericConstant(
      script ?? "",
      "MIN_TRACKED_FILES_PER_PACKAGE",
      "check-deploy-changeset.mjs",
    );
    // Under the smallest of the four packages (studio-server, 90 tracked
    // files), and far enough under that ordinary deletions do not trip it.
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(90);
  });
});

describe("an unresolvable base is a failure, never a skip", () => {
  /**
   * This is the ONE diff-scoped gate in the table, and `AGENTS.md` records why
   * every other one gave up on git refs: a ref-resolving ratchet printed
   * "skipping ratchet" and exited 0 in exactly the environments that get one
   * commit of history. That behaviour must not come back by this route.
   */
  test("the gate never reports success over a comparison it could not make", () => {
    const source = script ?? "";
    expect(source).toBeTypeOf("string");
    // The base-resolution failure path, asserted as a unit: it must be the one
    // that exits, and it must not print a word that reads as "carried on".
    const guard = source.slice(source.indexOf("function assertBaseResolves"));
    const body = guard.slice(0, guard.indexOf("\n}\n"));
    expect(body, "assertBaseResolves no longer slices out").toContain("cannot resolve");
    // The behaviour, not the wording. A first draft here asserted the body
    // contains no word matching /skip/i and failed on the gate's own message,
    // which says "rather than a skip" — the comment-versus-condition problem
    // this directory keeps meeting. What can actually regress is the exit:
    // turning this into a warn-and-continue means deleting this line.
    expect(body).toContain("process.exit(1)");
    expect(body).not.toContain("process.exit(0)");
  });
});

describe("the scope decides what a deploy carries", () => {
  test("DEPLOY_CARRIED names packages that exist", () => {
    // A renamed package would contribute no paths, match no change, and let the
    // gate print a checkmark over the hole it exists to close. The gate carries
    // the same floor at run time against `git ls-files`; this is the half that
    // fails in an ordinary test run.
    expect(scope?.DEPLOY_CARRIED.length).toBeGreaterThan(0);
    for (const pkg of scope?.DEPLOY_CARRIED ?? []) {
      expect(workspaceDirs, `DEPLOY_CARRIED names ${pkg}, which is not a package`).toContain(pkg);
    }
  });

  test("every carrier is itself carried", () => {
    for (const pkg of scope?.DEPLOY_CARRIERS ?? []) {
      expect(scope?.DEPLOY_CARRIED).toContain(pkg);
    }
  });

  test("the carriers are exactly the packages ship.yml's own gate names", () => {
    // The gate and the workflow must not be able to disagree about what arms a
    // deploy: a carrier this table forgot is a package whose change the gate
    // waves through, and one it invents is a changeset that ships nothing.
    const source = workflow ?? "";
    expect(source).toBeTypeOf("string");
    const named = [...source.matchAll(/^ +if bumped (\S+) \|\| bumped (\S+); then$/gm)].flatMap(
      (match) => [match[1], match[2]],
    );
    expect(named, "ship.yml's `bumped` condition no longer parses").toHaveLength(2);
    expect([...(scope?.DEPLOY_CARRIERS ?? [])].sort()).toEqual([...named].sort());
  });

  test("a shipped file triggers and a test file does not", () => {
    const shipped = [
      "packages/aai-server/src/sandbox.ts",
      "packages/aai-server/package.json",
      "packages/aai-server/modal_deploy.py",
      "packages/aai-server/guest-image.Dockerfile",
      "packages/aai-studio-client/index.html",
      "packages/aai-studio-client/src/styles.css",
      "packages/aai-guest/src/package-lock.json",
    ];
    const inert = [
      "packages/aai-server/src/sandbox.test.ts",
      "packages/aai-server/src/_pg-test-utils.ts",
      "packages/aai-server/src/test-utils.ts",
      "packages/aai-server/CLAUDE.md",
      "packages/aai-server/MODAL-CLAUDE.md",
      "packages/aai-server/turbo.json",
      "packages/aai-server/vitest.config.ts",
      "packages/aai-studio-client/src/hooks.test-d.ts",
      "packages/aai-studio-client/src/_jsdom-setup.ts",
      "packages/aai-server/coverage/index.html",
    ];
    for (const path of shipped) {
      expect(scope?.isShippedSource(path), `${path} should ship`).toBe(true);
    }
    for (const path of inert) {
      expect(scope?.isShippedSource(path), `${path} should NOT ship`).toBe(false);
    }
  });

  test("triggeringFiles groups by package and ignores everything else", () => {
    const grouped = scope?.triggeringFiles([
      "packages/aai-server/src/sandbox.ts",
      "packages/aai-server/src/sandbox.test.ts",
      "packages/aai-guest/src/harness.ts",
      // Not deploy-carried: published to npm, so it ships without a deploy.
      "packages/aai/src/sdk/agent.ts",
      "AGENTS.md",
      ".github/workflows/ship.yml",
    ]);
    expect([...(grouped?.keys() ?? [])].sort()).toEqual(["aai-guest", "aai-server"]);
    expect(grouped?.get("aai-server")).toEqual(["packages/aai-server/src/sandbox.ts"]);
  });

  test("nothing carried means nothing to ask for", () => {
    // The common case — a docs or SDK-only branch — must not be asked for a
    // platform changeset, or the gate becomes the thing people work around.
    expect(scope?.triggeringFiles(["AGENTS.md", "packages/aai/src/sdk/agent.ts"]).size).toBe(0);
  });
});

describe("the SCHEMA is carried too", () => {
  /**
   * The wider half of the same hole, and the one nothing else could have asked
   * about: this gate matched `packages/<carried>/` only, and `changeset status`
   * answers for workspace packages — which `supabase/` is not. So a
   * migration-only branch cleared the gate AND the pre-push hook, and the
   * migration then waited for whatever unrelated release next moved a version
   * line. It has fired once already, through
   * `20260808120000_agents_config_default.sql`.
   */
  test("a migration triggers the gate", () => {
    const grouped = scope?.triggeringFiles([
      "supabase/migrations/20260903030000_workflow_run_keys.sql",
    ]);
    expect([...(grouped?.keys() ?? [])]).toEqual([scope?.SCHEMA_DIR]);
  });

  test("only migrations/ is carried, not the rest of supabase/", () => {
    // `config.toml` configures the LOCAL stack and is never applied to
    // production; the README is prose. Scoping to the whole directory would
    // make every doc edit ask for a platform changeset, which is how a gate
    // becomes the thing people route around.
    const grouped = scope?.triggeringFiles([
      "supabase/config.toml",
      "supabase/README.md",
      "supabase/migrations/20260903030000_workflow_run_keys.sql",
    ]);
    expect(grouped?.get(scope?.SCHEMA_DIR ?? "")).toEqual([
      "supabase/migrations/20260903030000_workflow_run_keys.sql",
    ]);
    expect(grouped?.size).toBe(1);
  });

  test("SCHEMA_DIR names a directory that holds migrations", () => {
    // The same argument as `DEPLOY_CARRIED names packages that exist`: a
    // renamed directory contributes no paths, matches no change, and prints a
    // checkmark. The gate carries a `MIN_TRACKED_MIGRATIONS` floor against
    // `git ls-files`; this is the half that fails in an ordinary test run.
    expect(scope?.SCHEMA_DIR).toBe("supabase/migrations");
    expect(migrationFiles.length).toBeGreaterThan(15);
  });

  test("CARRIED_PREFIXES covers every package plus the schema, and nothing else", () => {
    // Derived rather than restated, so a package added to DEPLOY_CARRIED is in
    // scope with no second edit. Asserted because the derivation is the only
    // thing standing between the two lists and the drift this repo pays for.
    const keys = (scope?.CARRIED_PREFIXES ?? []).map(([key]) => key);
    expect(keys).toEqual([...(scope?.DEPLOY_CARRIED ?? []), scope?.SCHEMA_DIR]);
    for (const [key, prefix] of scope?.CARRIED_PREFIXES ?? []) {
      expect(prefix, `${key} prefix must end in a slash`).toMatch(/\/$/);
    }
  });

  test("the gate declares a floor for the schema corpus", () => {
    expect(script).toBeTypeOf("string");
    const floor = numericConstant(
      script ?? "",
      "MIN_TRACKED_MIGRATIONS",
      "check-deploy-changeset.mjs",
    );
    // Under the real count, so ordinary consolidation does not trip it, and
    // above zero, so a pathspec matching nothing still fails.
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(migrationFiles.length);
  });
});

describe("only a carrier satisfies it", () => {
  test("a carrier name counts and an SDK name does not", () => {
    // The strict reading, and the whole point of the gate: an SDK changeset
    // bumps both carriers as DEPENDENTS, so accepting it would have passed
    // #1341 — which shipped precisely because something else was being
    // released.
    expect(scope?.namedCarriers([{ name: "aai-server" }])).toEqual(["aai-server"]);
    expect(scope?.namedCarriers([{ name: "aai-studio-server" }])).toEqual(["aai-studio-server"]);
    expect(scope?.namedCarriers([{ name: "@alexkroman1/aai" }])).toEqual([]);
    expect(scope?.namedCarriers([{ name: "aai-studio-client" }, { name: "aai-guest" }])).toEqual(
      [],
    );
    expect(scope?.namedCarriers([])).toEqual([]);
  });

  test("a version bump on a carrier satisfies it too", () => {
    // Which is what keeps the Version Packages PR green: that branch DELETES
    // the changesets and writes the version lines, so on the changeset half it
    // looks exactly like the failure this gate reports. Reading the mechanism
    // beats exempting a branch NAME — nothing has to know what
    // `changeset-release/main` is called.
    const source = script ?? "";
    expect(source).toContain("function versionBumpedCarriers");
    expect(source).toMatch(/\^\\\+\.\*"version":/);
  });
});
