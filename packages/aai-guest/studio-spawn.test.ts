// Copyright 2026 the AAI authors. MIT license.
// The npm policy every guest spawn site shares. The two suites that drive npm
// (studio-project-tools-mocked, studio-workspace-deps) mock `runNpm` and
// assert only the verb and spec they own, so the standing flags, the cwd and
// the token-free env are pinned here — once — rather than restated at each
// call site the way they were when the two copies drifted.
//
// These run REAL npm, which is why they only ask it to read its own config:
// `npm config get` is local, needs no network, and is the one command that
// reports back what flags it was given.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { useTempDir } from "./_test-utils.ts";
import {
  cliChildEnv,
  NPM_OUTPUT_CAP,
  NPM_TIMEOUT_MS,
  PACKAGE_NAME_RE,
  runCapped,
  runNpm,
  WORKSPACE_CHILD_ENV_ALLOWLIST,
  workspaceChildEnv,
} from "./studio-spawn.ts";

const dir = useTempDir("aai-spawn-");

describe("runNpm", () => {
  test.for([
    ["audit", "false"],
    ["fund", "false"],
    ["loglevel", "error"],
  ])("passes --%s through to npm", async ([key, want]) => {
    const result = await runNpm(dir(), ["config", "get", key as string]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(want);
  });

  test("runs in the directory it is given", async () => {
    // `npm prefix` reports the nearest ANCESTOR holding a `package.json` or a
    // `node_modules`, not the cwd — so without one of those in `dir()` the answer
    // depends on what happens to sit above the temp directory. That is a real
    // flake and not a hypothetical: under `turbo run`, strict env mode strips
    // TMPDIR, `os.tmpdir()` falls back to `/tmp`, and a stray
    // `/tmp/node_modules` makes npm answer `/private/tmp`. Writing a manifest
    // here stops the walk at `dir()` whatever is above it. (TMPDIR is passed
    // through in turbo.json now too — the two fixes are independent.)
    await writeFile(path.join(dir(), "package.json"), '{"name":"probe","version":"1.0.0"}');
    const result = await runNpm(dir(), ["prefix"]);
    // macOS reports /private/var for /var; compare the resolved leaf instead.
    expect(result.stdout.trim().endsWith(path.basename(dir()))).toBe(true);
  });

  test("the timeout and cap are one pair, not two that must be kept in step", () => {
    // They were duplicated under a second name (INSTALL_TIMEOUT_MS /
    // INSTALL_OUTPUT_CAP) with nothing asserting the copies agreed.
    expect({ timeout: NPM_TIMEOUT_MS, cap: NPM_OUTPUT_CAP }).toEqual({
      timeout: 110_000,
      cap: 4000,
    });
  });
});

/**
 * The env handed to a child that runs WORKSPACE-AUTHORED code.
 *
 * This suite used to pin the opposite contract — `leaves the rest of the
 * environment alone` asserted that an arbitrary variable was inherited, which
 * is the deny-list this replaced, stated as a requirement. There is no pre-fix
 * FAILING observation for the leak itself, because the deny-list was COMPLETE
 * when it was written: `AAI_GUEST_TOKEN` really was the only secret in the
 * studio guest's exec env. What is asserted instead is the new contract, and
 * `refuses a boot key that did not exist when the policy was written` is the
 * one that would have caught the next `AAI_BUNDLE_URL` — it fails against the
 * old implementation.
 */
describe("workspaceChildEnv", () => {
  test("strips the control-channel bearer so workspace code cannot impersonate the host", () => {
    vi.stubEnv("AAI_GUEST_TOKEN", "secret");
    expect(workspaceChildEnv().AAI_GUEST_TOKEN).toBeUndefined();
  });

  test("refuses a boot key that did not exist when the policy was written", () => {
    // The whole point of the polarity flip. Agent mode's boot env already
    // carries a signed Storage URL and two platform addresses; under the
    // deny-list, adding any of them to the studio side would have reached
    // `bash` and `npm` with no diff for a reviewer to catch.
    vi.stubEnv("AAI_BUNDLE_URL", "https://storage.test/signed?token=secret");
    vi.stubEnv("AAI_PLATFORM_BASE_URL", "https://platform.test");
    vi.stubEnv("AAI_AGENT_ENV_PATH", "/boot/env.json");
    vi.stubEnv("AAI_WORKFLOW_API_TOKEN", "wf-secret");
    const env = workspaceChildEnv();
    expect(
      Object.keys(env).filter((k) => k.startsWith("AAI_") && k !== "AAI_SANDBOX_CONTAINED"),
    ).toEqual([]);
  });

  test("refuses a host credential, which the subprocess backend really supplies", () => {
    // `SANDBOX_BACKEND=subprocess` makes the harness a child of the server, so
    // `process.env` there is the developer's whole environment.
    for (const name of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_DB_URL",
      "MODAL_TOKEN_SECRET",
      "ANTHROPIC_API_KEY",
      "ASSEMBLYAI_API_KEY",
      "DATABASE_URL",
    ]) {
      vi.stubEnv(name, "secret");
    }
    const env = workspaceChildEnv();
    expect(Object.values(env)).not.toContain("secret");
  });

  test("copies nothing outside the allow-list", () => {
    vi.stubEnv("AAI_SPAWN_TEST_MARKER", "kept");
    const env = workspaceChildEnv();
    expect(Object.keys(env).filter((k) => !WORKSPACE_CHILD_ENV_ALLOWLIST.includes(k))).toEqual([]);
  });

  test("carries what npm and bash cannot run without", () => {
    // Breaking `npm install` in a studio workspace would be worse than the risk
    // this closes, so the two load-bearing names are asserted rather than
    // assumed. `runNpm` above drives REAL npm through this env.
    const env = workspaceChildEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  test("passes the ambient machine config a proxied or private-CA host needs", () => {
    // The set turbo.json's `globalPassThroughEnv` already treats as machine
    // config. Stripped, `npm install` fails with a misleading resolution error.
    for (const name of ["HTTPS_PROXY", "no_proxy", "npm_config_proxy", "NODE_EXTRA_CA_CERTS"]) {
      vi.stubEnv(name, `value-of-${name}`);
    }
    const env = workspaceChildEnv();
    expect({
      HTTPS_PROXY: env.HTTPS_PROXY,
      no_proxy: env.no_proxy,
      npm_config_proxy: env.npm_config_proxy,
      NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS,
    }).toEqual({
      HTTPS_PROXY: "value-of-HTTPS_PROXY",
      no_proxy: "value-of-no_proxy",
      npm_config_proxy: "value-of-npm_config_proxy",
      NODE_EXTRA_CA_CERTS: "value-of-NODE_EXTRA_CA_CERTS",
    });
  });

  test("does not prefix-match npm_config_, where npm keeps its credentials", () => {
    // The obvious shortcut, and exactly wrong: a prefix rule would re-open the
    // hole through the mechanism meant to close it.
    vi.stubEnv("npm_config__authToken", "npm-secret");
    vi.stubEnv("npm_config_registry", "https://registry.internal");
    const env = workspaceChildEnv();
    expect(env.npm_config__authToken).toBeUndefined();
    // Named to record the trade: a private registry is not reachable through
    // this env today, and the fix is a NAME here, never a prefix.
    expect(env.npm_config_registry).toBeUndefined();
  });

  test("omits an unset variable rather than passing the string undefined", () => {
    // `spawn` coerces an own property whose value is `undefined` to the STRING
    // "undefined", which is how a child ends up with `TMPDIR=undefined`.
    vi.stubEnv("TMPDIR", undefined);
    const env = workspaceChildEnv();
    expect(Object.hasOwn(env, "TMPDIR")).toBe(false);
    expect(Object.values(env)).not.toContain(undefined);
  });

  test("hands a child the scratch directory the SPAWNER named, not /tmp", async () => {
    // The other half of the `TMPDIR` story, and the half a test was missing:
    // the sibling below pins that an ABSENT variable stays absent, which is
    // what happens on a host that sets none. In a guest the spawner names one
    // — `microsandbox-sandbox.ts` / `modal-sandbox.ts` set `TMPDIR` in the
    // studio exec env, because `/tmp` under the local microVM is a 512 MiB RAM
    // disk (measured) — and the allow-list forwarding it is what makes that
    // reach an `npm install` and a workspace `bash`. A real child, because
    // `os.tmpdir()` reading the variable is the claim, not `spawn` copying it:
    // npm 11 no longer exposes a `tmp` config to ask.
    vi.stubEnv("TMPDIR", dir());
    const result = await runCapped(
      process.execPath,
      ["-e", "process.stdout.write(require('node:os').tmpdir())"],
      { cwd: dir(), env: workspaceChildEnv(), timeoutMs: 10_000, cap: 200 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(dir());
  });

  test("is a superset of cliChildEnv, which is the same shape for a stricter child", () => {
    // The in-guest deploy child takes `cliChildEnv`; this is that policy widened
    // by exactly what a shell and an install need. A name that lands in the
    // stricter list and NOT here would mean the child running tenant code lost
    // something the child running ours needs — `TMPDIR` being the live example.
    for (const [name, value] of Object.entries(cliChildEnv())) {
      expect(workspaceChildEnv()[name]).toBe(value);
    }
  });
});

/**
 * The env for the one child that runs OUR code: the in-guest `aai deploy`.
 *
 * It was `pathOnlyEnv`, forwarding PATH and nothing else, so the CLI bundler's
 * ~8 MB `mkdtemp(join(tmpdir(), …))` fell back to `/tmp` — a 512 MiB tmpfs
 * charged to guest RAM under the local microVM. The guest itself is on
 * `/var/tmp`; its own deploy child was not, and the function's doc claimed
 * "nothing but PATH" as a feature. See the function for what is still left out
 * and why.
 */
describe("cliChildEnv", () => {
  test("forwards the scratch directory the guest around it is using", () => {
    vi.stubEnv("TMPDIR", "/var/tmp");
    expect(cliChildEnv().TMPDIR).toBe("/var/tmp");
  });

  test("forwards every name os.tmpdir() reads, not just the first", () => {
    // `os.tmpdir()` reads TMPDIR, then TMP, then TEMP. Forwarding one would let
    // the child resolve a different directory than its parent.
    vi.stubEnv("TMPDIR", undefined);
    vi.stubEnv("TMP", "/var/tmp/a");
    vi.stubEnv("TEMP", "/var/tmp/b");
    expect(cliChildEnv()).toMatchObject({ TMP: "/var/tmp/a", TEMP: "/var/tmp/b" });
  });

  test("leaves an absent name ABSENT rather than the string undefined", () => {
    // `spawn` coerces an own `undefined` to `"undefined"`, which is how a child
    // ends up with a literal `TMPDIR=undefined`.
    vi.stubEnv("TMPDIR", undefined);
    vi.stubEnv("TMP", undefined);
    vi.stubEnv("TEMP", undefined);
    const env = cliChildEnv();
    for (const name of ["TMPDIR", "TMP", "TEMP"]) {
      expect(Object.hasOwn(env, name), name).toBe(false);
    }
  });

  test("carries no credential and no boot key", () => {
    // The narrow half of the claim, and the reason this is not
    // `workspaceChildEnv`: the guest's bearer and every `AAI_*` boot key stay out.
    vi.stubEnv("AAI_GUEST_TOKEN", "secret");
    vi.stubEnv("AAI_BUNDLE_URL", "https://blobs.test/signed");
    vi.stubEnv("HOME", "/root");
    // A SUBSET rather than an exact list: which of the three temp names the host
    // running this spec happens to set is not the claim — that nothing else gets
    // through is.
    for (const name of Object.keys(cliChildEnv())) {
      expect(["PATH", "TMPDIR", "TMP", "TEMP"], name).toContain(name);
    }
  });
});

describe("WORKSPACE_CHILD_ENV_ALLOWLIST", () => {
  test("has no duplicates and holds nothing that names a platform capability", () => {
    expect([...new Set(WORKSPACE_CHILD_ENV_ALLOWLIST)]).toEqual([...WORKSPACE_CHILD_ENV_ALLOWLIST]);
    // `AAI_SANDBOX_CONTAINED` is the one allowed `AAI_` name and is a flag, not
    // a capability; every other one is out.
    expect(WORKSPACE_CHILD_ENV_ALLOWLIST.filter((n) => n.startsWith("AAI_"))).toEqual([
      "AAI_SANDBOX_CONTAINED",
    ]);
  });

  test("NODE_ENV is deliberately absent", () => {
    // `production` makes `npm install` skip devDependencies, so inheriting it
    // decided whether a workspace could run its own tests from how the server
    // happened to be started.
    vi.stubEnv("NODE_ENV", "production");
    expect(WORKSPACE_CHILD_ENV_ALLOWLIST).not.toContain("NODE_ENV");
    expect(workspaceChildEnv().NODE_ENV).toBeUndefined();
  });
});

describe("PACKAGE_NAME_RE", () => {
  test.for(["date-fns", "ms", "@alexkroman1/aai", "@scope/name.with-dots"])(
    "%s is a package name",
    (name) => {
      expect(PACKAGE_NAME_RE.test(name)).toBe(true);
    },
  );

  test.for(["date-fns@4", "--registry", "../local", "@scope", "UPPER"])(
    "%s is not a package name",
    (name) => {
      expect(PACKAGE_NAME_RE.test(name)).toBe(false);
    },
  );
});
