// Copyright 2025 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { resolveDeployTarget } from "./_agent.ts";
import { buildAgentBundle, evalWorkerConfig } from "./_bundler.ts";
import { updateProjectConfig } from "./_config.ts";
import { runDeploy } from "./_deploy.ts";
import { type CommandResult, ok } from "./_output.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { projectNameFromDir } from "./_studio.ts";
import { assertTypechecks } from "./_typecheck-gate.ts";
import { fmtUrl, log, notify } from "./_ui.ts";
import { errorMessage } from "./_utils.ts";
import { determinismWarnings, scanWorkflowDeterminism } from "./_workflow-determinism.ts";

type DeployData = {
  slug: string;
  url: string;
  warnings?: string[];
  /**
   * One entry per carrier this agent's `telephony` declares, carrying the
   * webhook URL to configure the phone number with. Omitted when it declares
   * none, so a voice-only deploy's result stays exactly as it was.
   */
  webhooks?: { carrier: string; url: string }[];
};

export async function executeDeploy(opts: {
  cwd: string;
  server?: string | undefined;
  /** See DeployOpts.allowPreviewSlug (`--allow-preview-slug`; studio-internal). */
  allowPreviewSlug?: boolean | undefined;
  /** `--skipTypecheck`: deploy without the tsc gate. */
  skipTypecheck?: boolean | undefined;
}): Promise<CommandResult<DeployData>> {
  const { cwd } = opts;
  const { config: projectConfig, serverUrl, apiKey } = await resolveDeployTarget(cwd, opts.server);
  await assertTypechecks(cwd, { skip: opts.skipTypecheck });
  // Minify the worker for deploy — smaller upload and stored bundle. Dev
  // builds (`aai dev`) stay unminified for readable stack traces.
  // Loaded beside the build rather than at module scope: it pulls in the
  // SDK's runtime barrel for `requiredProviderEnvVars` (~320ms, ~35MB), and
  // a static import would charge that to every `aai deploy` — including runs
  // that die at auth or the typecheck gate above, and every per-edit preview
  // deploy the studio queues inside a one-CPU guest. Started here, it settles
  // inside the multi-second Vite build.
  const preflightModule = import("./_preflight.ts");
  const bundle = await buildAgentBundle(cwd, { minify: true });
  // ONE naming rule with `aai push`: the slug this directory already
  // deployed to, else the directory's own name. `projectNameFromDir` is
  // shared with the studio path, so both inherit its refusals — an unusable
  // basename, and the `*-preview` suffix the orphan sweep reaps hourly. Only
  // when it yields nothing does the platform mint a name, and it has nothing
  // to derive one from (see "The platform stores no agent config" in
  // packages/aai-server/CLAUDE.md), so that fallback is random words.
  const slug = projectConfig?.slug ?? projectNameFromDir(cwd) ?? undefined;

  const env = await resolveServerEnv(cwd);
  // The login key is the same floor the upload applies below, so the
  // preflight sees exactly the env the agent will start with.
  const uploadEnv = { ASSEMBLYAI_API_KEY: apiKey, ...env };

  // Import the bundle we just built: proves it loads (a top-level throw fails
  // HERE, not as a sandbox that never becomes ready) and yields the config the
  // preflight reads. The platform evaluates nothing, so this is the only
  // place either happens — see _preflight.ts.
  const {
    missingCredentialMessage,
    missingCredentials,
    missingTelephonySecretWarnings,
    missingTelephonySecrets,
    telephonyWebhooks,
  } = await preflightModule;
  const config = await evalWorkerConfig(bundle.worker);
  const missing = config ? missingCredentials(config, uploadEnv) : [];
  // The phone half of the same preflight, and a separate list because it is a
  // separate failure: a declared carrier with no signing secret DEPLOYS, serves
  // its webhook, and checks nothing — see `missingTelephonySecrets`.
  const missingPhone = config ? missingTelephonySecrets(config, uploadEnv) : [];
  // `notify`, not `log.warn`: JSON mode is auto-detected on a pipe and
  // silences `log` entirely, and a pipe is how studio Publish runs this. The
  // message also rides the result below, which is the channel Publish reads.
  // Joined to `warnings` rather than only notified, so a body-level clock or
  // fetch reaches studio Publish's channel too — that surface reads the result
  // and never stdout. A warning and not a gate: see `_workflow-determinism.ts`.
  const warnings = [
    ...(missing.length > 0 ? [missingCredentialMessage(missing)] : []),
    ...missingTelephonySecretWarnings(missingPhone),
    ...determinismWarnings(await scanWorkflowDeterminism(cwd)),
  ];
  for (const warning of warnings) notify("warn", warning);

  log.step(`Deploying${slug ? ` ${slug}` : ""}…`);
  const deployed = await runDeploy({
    url: serverUrl,
    bundle,
    // The login key is a FLOOR, not an override: an ASSEMBLYAI_API_KEY the
    // user declared in .env deliberately targets a different account and
    // must win — matching the server's own defaultEnv merge semantics.
    env: uploadEnv,
    ...omitUndefined({ slug }),
    ...(opts.allowPreviewSlug ? { allowPreviewSlug: true } : {}),
    apiKey,
  });

  const agentUrl = `${serverUrl}/${deployed.slug}`;

  // The deploy already succeeded server-side — a failure to record the slug
  // must not read as a failed deploy (and must surface the slug loudly, or
  // the next `aai deploy` would mint a fresh slug and orphan this agent).
  try {
    // Merge, never replace: a studio-linked directory's link fields
    // (studioProject/studioSourceHash) must survive a deploy.
    await updateProjectConfig(cwd, { slug: deployed.slug, serverUrl });
  } catch (err) {
    log.warn(
      `Deployed as ${deployed.slug}, but couldn't save .aai/project.json: ${errorMessage(err)}\n` +
        "  Write it manually so future deploys reuse this slug:\n" +
        `  ${JSON.stringify({ slug: deployed.slug, serverUrl })}`,
    );
  }

  log.success(`Deployed ${fmtUrl(agentUrl)}`);
  // The webhook URL per declared carrier, `?carrier=` already filled in. Both
  // halves are otherwise reconstructed by hand from the docs, and the platform
  // cannot supply either — its phone route defaults the parameter to `twilio`
  // against a hardcoded set and never reads the agent's declaration, so a
  // Telnyx number configured without it answers `403 Invalid webhook
  // signature`. `telephonyWebhooks` carries the rest; an agent that declares no
  // carrier prints nothing.
  const webhooks = config ? telephonyWebhooks(config, agentUrl) : [];
  for (const { carrier, url } of webhooks) {
    log.info(`${carrier} webhook (paste into the phone number's config): ${fmtUrl(url)}`);
  }

  return ok({
    slug: deployed.slug,
    url: agentUrl,
    ...(warnings.length > 0 ? { warnings } : {}),
    // On the RESULT too, for the reason `warnings` is: `log` is silenced in
    // JSON mode, JSON mode is auto-detected on a pipe, and studio Publish runs
    // this through one — so the surface that would show a user their webhook
    // URL reads the result and never stdout.
    ...(webhooks.length > 0 ? { webhooks } : {}),
  });
}
