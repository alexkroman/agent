// Copyright 2026 the AAI authors. MIT license.
/**
 * `resolveBuildTarget`, and what each target says it produced.
 *
 * The property worth pinning in the first is the PRECEDENCE, because two of its
 * three arms are invisible at a call site: a laptop build must not pick up a
 * host target, and a build ON a host must not need a flag the user has nowhere
 * to pass. In the second it is TOTALITY — every target answers where its output
 * went and how it ships, which is what a `log.info` per switch arm could not
 * guarantee and did not.
 *
 * Each host's emitted sources are asserted beside that host's own module
 * (`_vercel-target.test.ts`, `_deno-target.test.ts`, `_modal-target.test.ts`),
 * and the drain they share in `_target-drain.test.ts`.
 */

import { describe, expect, test } from "vitest";
import {
  BUILD_TARGETS,
  type BuildTarget,
  DEFAULT_BUILD_TARGET,
  isBuildTarget,
  resolveBuildTarget,
  resolveDeploySteps,
  SECRET_NAME_PLACEHOLDER,
  TARGET_ENV_MARKERS,
  TARGET_OUTPUTS,
} from "./_build-target.ts";
import { DENO_ENTRY_FILE, DENO_OUTPUT_DIR } from "./_deno-target.ts";
import { modalAppName, modalSecretName } from "./_modal-app.ts";
import { MODAL_APP_FILE, MODAL_OUTPUT_DIR } from "./_modal-target.ts";
import { VERCEL_OUTPUT_DIR } from "./_vercel-target.ts";

describe("resolveBuildTarget", () => {
  test("a laptop with no host markers gets the default, which emits nothing", () => {
    expect(resolveBuildTarget(undefined, {})).toBe(DEFAULT_BUILD_TARGET);
    // The whole point of the default: an existing project's build is unchanged.
    expect(DEFAULT_BUILD_TARGET).toBe("node");
  });

  test("deno is reachable by flag, and refuses nothing it accepts", () => {
    expect(resolveBuildTarget("deno", {})).toBe("deno");
    expect(isBuildTarget("deno")).toBe(true);
    expect(BUILD_TARGETS).toContain("deno");
  });

  test("modal is reachable by flag ONLY, and no environment reaches it", () => {
    expect(resolveBuildTarget("modal", {})).toBe("modal");
    expect(isBuildTarget("modal")).toBe(true);
    // `modal deploy` uploads a directory built on the developer's machine, so
    // no build ever runs on Modal's infrastructure and any marker would be dead
    // config. The two variables that DO exist in a Modal environment are set
    // inside a container — `MODAL_IS_REMOTE`, `MODAL_TASK_ID` — which is the
    // wrong end, and dangerously so here: this repo's own guest sandboxes are
    // Modal Sandboxes and studio Publish runs the CLI inside one, so detecting
    // on them would flip the platform's own build to this target.
    expect(resolveBuildTarget(undefined, { MODAL_IS_REMOTE: "1" })).toBe(DEFAULT_BUILD_TARGET);
    expect(resolveBuildTarget(undefined, { MODAL_TASK_ID: "ta-123" })).toBe(DEFAULT_BUILD_TARGET);
    // Credentials are not a statement about what this build is FOR: a developer
    // with these exported would otherwise get Modal output from a Vercel build.
    expect(resolveBuildTarget(undefined, { MODAL_TOKEN_ID: "ak-1" })).toBe(DEFAULT_BUILD_TARGET);
  });

  test("the host's own build container is detected with no flag", () => {
    // Vercel sets this on every build and deployment, so a project deployed
    // from a git push needs nothing configured — Nitro's zero-config property.
    expect(resolveBuildTarget(undefined, { VERCEL: "1" })).toBe("vercel");
    // All three of `std-env`'s Vercel tests, not just the one: `VERCEL_ENV` is
    // what Vercel's own docs point at, and `NOW_BUILDER` is set on the BUILD
    // container and predates both, so it is the one that may appear alone.
    expect(resolveBuildTarget(undefined, { VERCEL_ENV: "production" })).toBe("vercel");
    expect(resolveBuildTarget(undefined, { NOW_BUILDER: "1" })).toBe("vercel");
    // Deno Deploy's documented marker. Note the flag is the path that matters
    // for this target — `deno deploy` uploads a directory built on the
    // developer's own machine — so detection is convenience, not the mechanism.
    expect(resolveBuildTarget(undefined, { DENO_DEPLOY: "true" })).toBe("deno");
    // Both of Deno Deploy's markers, because neither covers both GENERATIONS
    // of the platform: Classic sets `DENO_DEPLOYMENT_ID` and no `DENO_DEPLOY`,
    // so reading only the latter left Classic undetectable. Asserted separately
    // from the map-consistency test below, which derives from
    // `TARGET_ENV_MARKERS` and so cannot notice a missing key.
    expect(resolveBuildTarget(undefined, { DENO_DEPLOYMENT_ID: "abc123" })).toBe("deno");
  });

  test("an explicit target beats the environment, in both directions", () => {
    expect(resolveBuildTarget("node", { VERCEL: "1" })).toBe("node");
    expect(resolveBuildTarget("vercel", {})).toBe("vercel");
  });

  test("the accepted list in the error names every target", () => {
    // The message is the only place a user learns what exists, so a target
    // added without reaching this list is a target nobody can discover.
    for (const target of BUILD_TARGETS) {
      expect(() => resolveBuildTarget("netlify", {})).toThrow(new RegExp(target));
    }
  });

  test("an unknown target is REFUSED, naming what is accepted", () => {
    // Never a fallback to the default: a typo that quietly built `node` would
    // deploy a project missing the entry its host needs, and the failure would
    // arrive as a 404 from the platform rather than an error from the build.
    expect(() => resolveBuildTarget("netlify", {})).toThrow(/Unknown build target "netlify"/);
    expect(() => resolveBuildTarget("netlify", {})).toThrow(/node, vercel, deno, modal/);
  });

  test("an empty marker value does not count as being on that host", () => {
    // `VERCEL=` in a shell is how somebody unsets it; reading it as truthy
    // would emit a Vercel entry on a laptop.
    expect(resolveBuildTarget(undefined, { VERCEL: "" })).toBe(DEFAULT_BUILD_TARGET);
  });

  test("every marker names a real target, and every target is REACHABLE", () => {
    // A marker naming a target that does not exist is dead detection.
    for (const target of Object.values(TARGET_ENV_MARKERS)) {
      expect(BUILD_TARGETS).toContain(target);
    }
    // Reachability is the invariant that matters, and the FLAG is what carries
    // it. This used to demand a marker per non-default target, which reads as
    // the same claim and is not: it forces a host whose deploy step uploads a
    // locally-built directory — `modal deploy`, and `deno deploy` in its
    // ordinary flow — to invent a variable no build ever sees. A target
    // nothing can select is the real failure, so that is what is asserted.
    for (const target of BUILD_TARGETS) {
      expect(resolveBuildTarget(target, {})).toBe(target);
    }
  });

  test("isBuildTarget narrows only the declared set", () => {
    expect(isBuildTarget("vercel")).toBe(true);
    expect(isBuildTarget("netlify")).toBe(false);
  });
});
/**
 * The one command that SHIPS a target — its `each` step.
 *
 * A helper because the assertions below are about that command specifically,
 * and reaching through the sequence at each call site would let a test quietly
 * start asserting against the create or the secret step instead.
 */
function shipStep(target: BuildTarget): string {
  const run = TARGET_OUTPUTS[target].deploy?.find((step) => step.when === "each")?.run;
  if (run === undefined) throw new Error(`${target} has no ship step`);
  return run;
}

describe("what each target says it produced", () => {
  test("every target answers both questions, because the record is TOTAL", () => {
    // The point of the table over a `log.info` per switch arm: a new target
    // cannot be added without deciding what it emits and how it ships. An arm
    // can be — and was — simply left out, which is how `--target vercel` came
    // to print the directory it wrote and no deploy command at all.
    for (const target of BUILD_TARGETS) {
      expect(TARGET_OUTPUTS[target]).toBeDefined();
    }
    expect(Object.keys(TARGET_OUTPUTS).sort()).toEqual([...BUILD_TARGETS].sort());
  });

  test("every target that WRITES a directory says how to deploy it", () => {
    // The pairing is the invariant: an artifact nobody knows the command for
    // has not been delivered. `node` writes nothing and so owes no deploy
    // command — it owes a preview, which is `aai start`.
    for (const target of BUILD_TARGETS) {
      const output = TARGET_OUTPUTS[target];
      if (output.dir === undefined) {
        expect(output.deploy).toBeUndefined();
        expect(output.preview).toBeDefined();
      } else {
        expect(output.deploy ?? []).not.toHaveLength(0);
      }
    }
    expect(TARGET_OUTPUTS.node.dir).toBeUndefined();
  });

  test("a directory-shaped host's commands RUN FROM the directory", () => {
    // `deno deploy` uploads the WORKING directory, so a command run from the
    // project root would upload the project — node_modules, source and the
    // developer's .env included. Nitro's deno-deploy preset writes the same cd.
    expect(shipStep("deno")).toContain(`cd ${DENO_OUTPUT_DIR}`);
    expect(TARGET_OUTPUTS.deno.preview).toContain(`cd ${DENO_OUTPUT_DIR}`);
    // Modal is pointed at a MODULE instead, so both of its commands name it —
    // there is nothing in the directory to infer it from.
    expect(shipStep("modal")).toContain(MODAL_APP_FILE);
    expect(TARGET_OUTPUTS.modal.preview).toContain(MODAL_APP_FILE);
  });

  test("each emitting target names the directory its own emit writes", () => {
    // A command that names a path the build never wrote is worse than none.
    expect(TARGET_OUTPUTS.vercel.dir).toBe(VERCEL_OUTPUT_DIR);
    expect(TARGET_OUTPUTS.deno.dir).toBe(DENO_OUTPUT_DIR);
    expect(TARGET_OUTPUTS.modal.dir).toBe(MODAL_OUTPUT_DIR);
  });

  test("Vercel offers no preview, deliberately", () => {
    // Its function is invoked by a platform launcher nothing local reproduces,
    // and `vercel dev` rebuilds from source while ignoring `.vercel/output/` —
    // so naming it would point a user at a different program than the one they
    // just built.
    expect(TARGET_OUTPUTS.vercel.preview).toBeUndefined();
    expect(shipStep("vercel")).toBe("vercel deploy --prebuilt");
  });

  test("every deploy sequence STARTS with a build and ends with exactly one ship", () => {
    // The two structural claims the sequence exists to make. The `build` step
    // is first because it is a prerequisite of everything after it and the one
    // whose omission is SILENT — both hosts upload the emitted directory as it
    // stands, so a forgotten rebuild ships the previous bundle and reports
    // success. Exactly one `each` because that is the command that deploys:
    // two would mean the sequence never says which one ships it.
    for (const target of BUILD_TARGETS) {
      const steps = TARGET_OUTPUTS[target].deploy;
      if (steps === undefined) continue;
      expect(steps[0]?.when).toBe("build");
      expect(steps[0]?.run).toBe(`aai build --target ${target}`);
      expect(steps.filter((s) => s.when === "each")).toHaveLength(1);
      expect(steps.at(-1)?.when).toBe("each");
    }
  });

  test("every host that takes a secret names the command, which deno and modal did not", () => {
    // The regression this shape was built for. `TargetOutput.secret` was
    // absent for `deno` and `modal` — the two hosts whose secret command a
    // reader is least likely to guess — so `missingEnvWarnings` fell back to
    // "Set it in the <target> environment" and named nothing to run.
    for (const target of ["vercel", "deno", "modal"] as const) {
      const secret = TARGET_OUTPUTS[target].deploy?.find((s) => s.when === "perSecret");
      expect(secret?.run).toContain(SECRET_NAME_PLACEHOLDER);
    }
  });

  test("only deno needs a one-time create, and it overrides Deploy's detection", () => {
    // Every flag was established by a failed revision: Deploy's auto-detected
    // config for this directory resolves to no entrypoint and fails at
    // `building`, and the create is refused outright without a region.
    const once = TARGET_OUTPUTS.deno.deploy?.filter((s) => s.when === "once") ?? [];
    expect(once).toHaveLength(1);
    expect(once[0]?.run).toContain("--do-not-use-detected-build-config");
    expect(once[0]?.run).toContain(`--entrypoint ${DENO_ENTRY_FILE}`);
    expect(once[0]?.run).toContain("--region");

    // Modal creates its app on first deploy, so it has nothing to run once.
    expect(TARGET_OUTPUTS.modal.deploy?.some((s) => s.when === "once")).toBe(false);
    expect(TARGET_OUTPUTS.vercel.deploy?.some((s) => s.when === "once")).toBe(false);
  });
});

describe("resolveDeploySteps", () => {
  test("expands the secret step once per missing variable, with the real name", () => {
    const steps = resolveDeploySteps("deno", {
      agentName: "Quickstart Assistant",
      missingEnv: ["ASSEMBLYAI_API_KEY", "BRAVE_API_KEY"],
    });
    const secrets = steps.filter((s) => s.when === "perSecret");
    expect(secrets).toHaveLength(2);
    expect(secrets[0]?.run).toContain("ASSEMBLYAI_API_KEY");
    expect(secrets[1]?.run).toContain("BRAVE_API_KEY");
    // Substituted, not left for the reader to fill.
    expect(secrets.map((s) => s.run).join()).not.toContain(SECRET_NAME_PLACEHOLDER);
  });

  test("KEEPS the secret step when nothing is missing, because the host is not the build", () => {
    // `missingDeployEnv` reads the BUILD's environment. An empty set means
    // "your shell had these", never "the platform does" — so dropping the step
    // would promise a configured host nobody configured.
    const steps = resolveDeploySteps("deno", { agentName: "A", missingEnv: [] });
    const secrets = steps.filter((s) => s.when === "perSecret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.run).toContain(SECRET_NAME_PLACEHOLDER);
  });

  test("fills Modal's derived secret name, which app.py must agree with", () => {
    // A reader who invents this name gets a deploy that dies on
    // `Secret.from_name`, so it is substituted rather than left as a prompt.
    const steps = resolveDeploySteps("modal", {
      agentName: "Quickstart Assistant",
      missingEnv: ["ASSEMBLYAI_API_KEY"],
    });
    const secret = steps.find((s) => s.when === "perSecret");
    expect(secret?.run).toContain(modalSecretName(modalAppName("Quickstart Assistant")));
    expect(secret?.run).toBe(
      "modal secret create quickstart-assistant-env ASSEMBLYAI_API_KEY=<value>",
    );
  });

  test("a target that deploys nowhere resolves to no steps", () => {
    expect(resolveDeploySteps("node", { agentName: "A", missingEnv: [] })).toEqual([]);
  });
});
