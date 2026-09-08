// Copyright 2026 the AAI authors. MIT license.
/**
 * Deployment TARGETS — what `aai build` emits beside the worker so a host can
 * run this project without the project holding anything host-specific.
 *
 * ## Why a target rather than a file in the scaffold
 *
 * Every host wants a different entry shape: Vercel wants a module whose default
 * export is an `http.Server` it binds itself, a container wants a long-lived
 * process, another platform wants something else again. Committing one of those
 * to the scaffold makes every project assert a fact that is load-bearing on
 * exactly one host — the same objection that removed `server.mjs`.
 *
 * Nitro is the worked precedent: one codebase, a preset per provider, and the
 * preset EMITS the host's expected shape into the build directory. `node-server`
 * is its default and Vercel/Netlify/Cloudflare are detected from the CI
 * environment with no configuration. Next does the same narrower thing with
 * `output: "standalone"` — it generates a `server.js` rather than asking anyone
 * to write one. Either way the user's repository contains no host file, which is
 * the property to preserve here.
 *
 * ## Auto-detection, and why it is safe
 *
 * A target is chosen with `--target`, or detected from the environment when the
 * flag is absent. Detection reads the variables the hosts set on their own build
 * containers ({@link TARGET_ENV_MARKERS}), so it only ever fires where the build
 * is genuinely running on that host — a laptop sets none of them and gets
 * {@link DEFAULT_BUILD_TARGET}, which emits nothing extra and is what every
 * existing project already does.
 *
 * ## What is here, and what is one module over
 *
 * This file is the VOCABULARY: which targets exist, which one this build is,
 * and — through {@link TARGET_OUTPUTS} — what each produced and how it ships.
 * Each host's own constants and emitted sources live beside it, one module per
 * host (`_vercel-target.ts`, `_deno-target.ts`, `_modal-target.ts`), which is
 * the shape Nitro's `presets/<provider>/` has and the shape this file grew out
 * of: it held all three and went over the 500-line cap. The dependency runs one
 * way — this module reads each host's output directory, and no host module
 * reads this one — so a fourth target is a fourth file plus two lines here.
 */

import path from "node:path";
import { DENO_ENTRY_FILE, DENO_OUTPUT_DIR } from "./_deno-target.ts";
import { modalAppName, modalSecretName } from "./_modal-app.ts";
import { MODAL_APP_FILE, MODAL_OUTPUT_DIR } from "./_modal-target.ts";
import { VERCEL_OUTPUT_DIR } from "./_vercel-target.ts";

/**
 * What a {@link DeployStep} puts where a variable NAME goes.
 *
 * Angle brackets rather than a `$NAME` or `%s`: the string is printed for a
 * human to adapt as often as it is substituted into, and both of the other two
 * are shell-significant enough to be mistaken for something to type literally.
 */
export const SECRET_NAME_PLACEHOLDER = "<NAME>";

/**
 * The placeholders {@link resolveDeploySteps} FILLS, and the ones it leaves.
 *
 * The line between them is who KNOWS the value at build time, and it is worth
 * stating because it is the same line `.env.example` draws: this build knows
 * every declared variable name and the agent's own name, so leaving those as
 * placeholders would be withholding something it could have printed. It knows
 * nothing about the reader's account — an org, an app that may not exist yet —
 * or about a secret's VALUE, which is the whole point of declarations shipping
 * while values do not.
 *
 * So {@link SECRET_NAME_PLACEHOLDER} and {@link MODAL_SECRET_PLACEHOLDER} are
 * substituted, and these three survive into the printed command as prompts for
 * the reader to fill.
 */
export const ORG_PLACEHOLDER = "<ORG>";
/** @see ORG_PLACEHOLDER */
export const APP_PLACEHOLDER = "<APP>";
/** @see ORG_PLACEHOLDER */
export const SECRET_VALUE_PLACEHOLDER = "<value>";

/**
 * Where Modal's derived secret name goes — see {@link modalSecretName}.
 *
 * Substituted rather than left for the reader, because `app.py` DERIVES that
 * name from the agent's own and a reader who invents one gets a deploy that
 * fails on `Secret.from_name`. The emitted file's docstring already prints the
 * resolved name; this is the same string reaching the same reader one surface
 * earlier.
 */
export const MODAL_SECRET_PLACEHOLDER = "<secret>";

/** The targets `aai build --target` accepts. */
export const BUILD_TARGETS = ["node", "vercel", "deno", "modal"] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

/**
 * What a build with no `--target` and no host environment produces: the worker
 * and the client, and nothing else.
 *
 * `node` rather than a `"none"` sentinel because it NAMES the deployment it
 * serves — a long-lived process running `aai start` — which is what every
 * container platform wants and what the scaffold's own `start` script runs.
 */
export const DEFAULT_BUILD_TARGET: BuildTarget = "node";

/**
 * The environment variable each host sets on its own build container.
 *
 * `VERCEL` is set for every Vercel build and deployment. Detection is per host
 * rather than a single "am I in CI" test, because a GitHub Action building a
 * container image is CI too and wants the default.
 *
 * **Three keys for Vercel, not one**, and they are the three `std-env` tests —
 * the library Nitro detects providers with, and which this file already cites
 * for the Deno pair below. `VERCEL_ENV` is the variable Vercel's own docs point
 * at for "which environment is this" and is present wherever `VERCEL` is;
 * `NOW_BUILDER` is set on the BUILD container and predates both, so it is the
 * one a legacy or a `vercel build` invocation may carry alone. Reading one key
 * for a host that advertises itself with three is the same hole the Deno pair
 * below was found to have, one platform generation earlier.
 *
 * `DENO_DEPLOY` and `DENO_DEPLOYMENT_ID` are both Deno Deploy's "you are
 * running here" variables, and BOTH are listed because neither one covers both
 * GENERATIONS of the platform. Deno Deploy Classic sets `DENO_DEPLOYMENT_ID`
 * and `DENO_REGION` and no `DENO_DEPLOY` at all; the current platform sets
 * both. So `DENO_DEPLOYMENT_ID` is the only marker present in either, and
 * reading just `DENO_DEPLOY` — as this did — left Classic undetectable. That is
 * why `std-env` (the library Nitro detects providers with) tests the pair as
 * ONE signal, and why Nitro's Deno preset reads that one for its manifest.
 *
 * These are read at BUILD time, and that is reachable rather than theoretical:
 * Deno Deploy's git integration runs the build on its OWN infrastructure with
 * them set — its reference singles out `DENO_TIMELINE` as the one variable NOT
 * set during a build — so `aai build` there resolves this target with no flag,
 * the same zero-config property `VERCEL` gives.
 *
 * What detection cannot see is the documented LOCAL flow, and the reason is
 * ORDERING rather than a missing marker: `aai build --target deno` then
 * `deno deploy` from `.aai/deno/` finishes the build on the developer's own
 * machine before the upload command runs at all, so there is no host
 * environment left to advertise itself. Nitro has the identical hole and
 * answers it the same way — its own docs pass `NITRO_PRESET=deno_deploy`
 * explicitly. The flag is the path that matters; detection covers the host that
 * builds FOR you.
 *
 * **`modal` has NO marker, and cannot**: it is the LOCAL flow above with no
 * host-built alternative. Modal runs no build of its own — `modal deploy`
 * uploads a directory whose build already finished — so every Modal deploy is
 * the case the paragraph above says detection cannot see, and any variable
 * listed here would be dead config by construction.
 *
 * Worse than dead, and this is the part specific to us. The two variables that
 * DO appear in a Modal environment are set inside a CONTAINER
 * (`MODAL_IS_REMOTE`, `MODAL_TASK_ID`), which is the wrong end — and this
 * repo's own guest sandboxes ARE Modal Sandboxes, with studio Publish running
 * the CLI inside one, so detecting on them would flip the platform's own build
 * to this target. `MODAL_TOKEN_ID` fails the ordinary way: credentials in the
 * environment are not a statement about what a build is FOR, so anyone with
 * Modal creds exported would get Modal output from a Vercel build.
 *
 * So `modal` is reachable by its flag alone. The reachability test in
 * `_build-target.test.ts` asserts every target is selectable that way, rather
 * than demanding a marker per target — which reads as the same claim and is
 * not, since it would force a host like this one to invent a variable no build
 * ever sees.
 */
export const TARGET_ENV_MARKERS: Readonly<Record<string, BuildTarget>> = {
  VERCEL: "vercel",
  VERCEL_ENV: "vercel",
  NOW_BUILDER: "vercel",
  DENO_DEPLOY: "deno",
  DENO_DEPLOYMENT_ID: "deno",
};

export function isBuildTarget(value: string): value is BuildTarget {
  return (BUILD_TARGETS as readonly string[]).includes(value);
}

/**
 * Resolve the target for this build: an explicit flag wins, then the
 * environment, then {@link DEFAULT_BUILD_TARGET}.
 *
 * An unrecognised `--target` is REFUSED naming what is accepted, rather than
 * falling back to the default — a typo'd target that silently built the default
 * would deploy a project missing the entry its host needs, and the failure would
 * arrive as a 404 from the platform rather than as an error from the build.
 */
export function resolveBuildTarget(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
): BuildTarget {
  if (explicit !== undefined) {
    if (!isBuildTarget(explicit)) {
      throw new Error(`Unknown build target "${explicit}". Accepted: ${BUILD_TARGETS.join(", ")}.`);
    }
    return explicit;
  }
  for (const [marker, target] of Object.entries(TARGET_ENV_MARKERS)) {
    if (env[marker]) return target;
  }
  return DEFAULT_BUILD_TARGET;
}

/**
 * What one target's emit produces, and the commands that run it.
 *
 * Nitro's presets each carry a `commands: { preview, deploy }` pair, which it
 * writes into the build output's own `nitro.json` and prints after a build
 * ("You can deploy this build using …"). The reason to copy that shape rather
 * than keep the strings at the log site is what it fixes here: the Vercel
 * target printed the DIRECTORY it wrote and never the command that ships it, so
 * the one target reachable with no flag at all was also the one that told you
 * nothing about what to do next. A target that emits an artifact nobody knows
 * how to deploy has emitted nothing.
 *
 * Data rather than a `case` arm per target for the ordinary reason: this is a
 * total record over {@link BuildTarget}, so a new target cannot be added
 * without answering both questions, where a `log.info` inside a switch can be
 * — and was — simply left out.
 */
export interface TargetOutput {
  /**
   * Where the emit lands, relative to the project root. Absent for a target
   * that writes nothing beyond the worker and the client.
   */
  readonly dir?: string;
  /**
   * Run this deployment locally, the way the host runs it. Absent where there
   * is no honest answer: Vercel's function is invoked by a platform launcher
   * that nothing local reproduces, and offering `vercel dev` — which rebuilds
   * from source and ignores `.vercel/output/` — would be pointing a user at a
   * different program than the one they just built.
   */
  readonly preview?: string;
  /**
   * Ship what was just emitted — the ORDERED sequence, not one command.
   *
   * It was one string, and the string was WRONG for both hosts that have a
   * local flow. Measured end to end: `cd .aai/deno && deno deploy` fails
   * `APP_NOT_FOUND` because the app has to be created first; the create then
   * has to override Deploy's auto-detected build config, which for this
   * directory resolves to no entrypoint and fails at `building`; and the
   * deployment then fails at `warming` until the declared secret is set,
   * because this server crashes in `createRuntime` without a provider
   * credential rather than starting and failing later. Three distinct
   * failures, none of which a one-liner prepares a reader for. `modal deploy`
   * has the milder version of the same shape — `app.py` resolves
   * `Secret.from_name` at deploy time, so it dies unless the secret exists.
   *
   * Absent for a target with no honest answer — `node`, which deploys nowhere.
   */
  readonly deploy?: readonly DeployStep[];
}

/**
 * WHEN a step runs, which is the whole reason the sequence is data.
 *
 * A reader needs three different things from these commands and a flat list
 * answers none of them: which command they must re-run on every deploy, which
 * one they run once per app and never again, and which one repeats per secret.
 * Rendering differs per case too — see `build.ts`, where the post-build log
 * omits `build` (the reader just ran one) while the `--json` result keeps it,
 * because a CI job scripting a fresh checkout genuinely has to run it.
 *
 * - `build` — `aai build --target <t>`. **Mandatory before every deploy**, and
 *   the one step whose omission is silent: `deno deploy` and `modal deploy`
 *   both upload the emitted directory AS IT STANDS, so a forgotten rebuild
 *   ships the previous bundle and reports success. Deno prints "No files were
 *   changed, so there is nothing to upload", which reads like a no-op rather
 *   than like a stale deployment.
 * - `once` — creating or linking the app. A LABEL and not a branch: whether
 *   the app exists is account state on someone else's platform, so this is
 *   printed with its caveat rather than conditionally hidden. Guessing would
 *   either hide the step a first-timer needs or nag forever.
 * - `perSecret` — expanded per variable `missingDeployEnv` reported, with the
 *   real name substituted. This is what replaced {@link TargetOutput}'s old
 *   `secret` field, which was absent for `deno` and `modal` on the grounds
 *   that their commands were "unverified here" — so the warning for the two
 *   hosts that most need one said only "Set it in the deno environment".
 * - `each` — the upload itself.
 */
export type DeployStepWhen = "build" | "once" | "perSecret" | "each";

/** One command in a target's {@link TargetOutput.deploy} sequence. */
export interface DeployStep {
  readonly when: DeployStepWhen;
  /** The command, carrying any of the placeholders above. */
  readonly run: string;
}

/**
 * Every target's output and commands.
 *
 * The two directory-shaped hosts get a `cd` rather than a path argument,
 * because that is what their tooling takes: `deno deploy` uploads the WORKING
 * directory (see {@link DENO_OUTPUT_DIR}), so running it from the project root
 * would upload the project. Nitro's `deno-deploy` preset writes its command
 * with the same `cd`.
 */
export const TARGET_OUTPUTS: Readonly<Record<BuildTarget, TargetOutput>> = {
  // Nothing is emitted, so there is nothing to name — `aai start` boots the
  // worker `aai build` already wrote, which is what the scaffold's own `start`
  // script runs and what a container platform is pointed at.
  node: { preview: "aai start" },
  vercel: {
    dir: VERCEL_OUTPUT_DIR,
    deploy: [
      { when: "build", run: "aai build --target vercel" },
      // `production` is named explicitly because omitting it makes the CLI
      // prompt for the environments interactively, which is not a command a
      // reader can paste into CI — and because a build that emitted this
      // target IS the deployment about to go out.
      { when: "perSecret", run: `vercel env add ${SECRET_NAME_PLACEHOLDER} production` },
      // `--prebuilt` is the flag that makes the `build` step above
      // load-bearing: it means "do not build, ship `.vercel/output` as it
      // stands".
      { when: "each", run: "vercel deploy --prebuilt" },
    ],
  },
  deno: {
    dir: DENO_OUTPUT_DIR,
    // The `start` task {@link DENO_CONFIG_SOURCE} writes — which is the whole
    // reason that file is emitted, so the command that uses it belongs here.
    preview: `cd ${DENO_OUTPUT_DIR} && deno task start`,
    deploy: [
      { when: "build", run: "aai build --target deno" },
      // Every flag here was established by a failed revision, so none is
      // decoration. `--source local` because this directory was built here and
      // Deploy is not cloning a repo to build it; `--region` because the create
      // is REFUSED without one; and the runtime pair because Deploy's own
      // detection of this directory produces a config with no entrypoint that
      // fails at `building` — `deno.json`'s `start` task is not something it
      // infers an entry from.
      {
        when: "once",
        run:
          "deno deploy create --source local --region us" +
          ` --runtime-mode dynamic --entrypoint ${DENO_ENTRY_FILE}` +
          " --do-not-use-detected-build-config" +
          ` --org ${ORG_PLACEHOLDER} --app ${APP_PLACEHOLDER}`,
      },
      {
        when: "perSecret",
        run:
          `deno deploy env add ${SECRET_NAME_PLACEHOLDER} ${SECRET_VALUE_PLACEHOLDER}` +
          ` --org ${ORG_PLACEHOLDER} --app ${APP_PLACEHOLDER}`,
      },
      // The `cd` for the reason this record's doc gives: `deno deploy` uploads
      // the WORKING directory, so run from the project root it ships the
      // project. `--prod` because omitting it deploys a preview, and a reader
      // following printed instructions means the deployment they just built.
      {
        when: "each",
        run:
          `cd ${DENO_OUTPUT_DIR} && deno deploy --prod` +
          ` --org ${ORG_PLACEHOLDER} --app ${APP_PLACEHOLDER}`,
      },
    ],
  },
  modal: {
    dir: MODAL_OUTPUT_DIR,
    // Modal is pointed at a MODULE rather than at a directory, so both of these
    // name `app.py` — there is nothing in the directory to infer it from.
    preview: `modal serve ${path.join(MODAL_OUTPUT_DIR, MODAL_APP_FILE)}`,
    deploy: [
      { when: "build", run: "aai build --target modal" },
      // No `once` step: Modal creates the app on first deploy, so there is
      // nothing to run one time. The secret is the only prerequisite, and it
      // is a hard one — `app.py` resolves `Secret.from_name` at deploy time.
      {
        when: "perSecret",
        run:
          `modal secret create ${MODAL_SECRET_PLACEHOLDER}` +
          ` ${SECRET_NAME_PLACEHOLDER}=${SECRET_VALUE_PLACEHOLDER}`,
      },
      { when: "each", run: `modal deploy ${path.join(MODAL_OUTPUT_DIR, MODAL_APP_FILE)}` },
    ],
  },
};

/**
 * The sequence a reader should actually run: placeholders this build can fill
 * FILLED, and the `perSecret` step expanded once per variable that needs one.
 *
 * Resolved here rather than at the log site so the `--json` result and the
 * printed lines cannot disagree — the defect that produced this whole shape was
 * a deploy instruction that lived as a string at one call site and was wrong.
 *
 * With nothing missing, the `perSecret` step is kept ONCE in placeholder form
 * rather than dropped, and that is deliberate: `missingDeployEnv` reads the
 * BUILD's environment, which says nothing about what the host has (its own doc
 * makes this point), so an empty `missing` means "your shell had these", not
 * "the platform does". Dropping the step there would quietly promise a host is
 * configured when nobody has configured it.
 */
export function resolveDeploySteps(
  target: BuildTarget,
  options: { readonly agentName: string; readonly missingEnv: readonly string[] },
): DeployStep[] {
  const steps = TARGET_OUTPUTS[target].deploy;
  if (steps === undefined) return [];
  const secret = modalSecretName(modalAppName(options.agentName));
  const fill = (run: string): string => run.replaceAll(MODAL_SECRET_PLACEHOLDER, secret);
  return steps.flatMap((step) => {
    if (step.when !== "perSecret") return [{ ...step, run: fill(step.run) }];
    if (options.missingEnv.length === 0) return [{ ...step, run: fill(step.run) }];
    return options.missingEnv.map((name) => ({
      when: step.when,
      run: fill(step.run).replaceAll(SECRET_NAME_PLACEHOLDER, name),
    }));
  });
}
