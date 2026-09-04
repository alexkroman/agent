// Copyright 2026 the AAI authors. MIT license.
/**
 * One client for a deployed agent's WHOLE HTTP API — the front door and the
 * workflow routes, on one object, from one import.
 *
 * A deployed agent IS an API, and it answers on two surfaces rather than one:
 * `GET /client-config` says what the agent is (its name, its greeting, whether
 * its front door is a voice session or a page, and the live session's WebSocket
 * URL), and `/workflows/*` is everything durable. Those are documented together
 * — the studio's API pane and the public page at `/studio/api/<slug>` render one
 * page out of both — so a reader following that page had to build two clients,
 * one of which was a `fetch` and a hand-written URL join.
 *
 * ```ts
 * import { createAgentClient } from "@alexkroman1/aai/workflow-api";
 *
 * const agent = createAgentClient({ baseUrl: "https://agents.example/my-agent" });
 * const { name, page } = await agent.config();
 * const run = await agent.startAndWait("digest", { topic: "ai" });
 * ```
 *
 * **It is a SUPERSET of `createWorkflowApiClient`, not a wrapper around a
 * different design.** Every workflow method is that client's, so there is one
 * implementation of the routes, one failure convention, and nothing new to keep
 * in step; what this adds is the read that was not on it. Reach for the narrower
 * factory when a caller genuinely only has workflows — the browser client does,
 * because a page already knows what it is.
 *
 * **Nothing here is re-validated.** `config()` resolves the agent's own JSON
 * typed as {@link ClientConfigResponse}, which is the same posture as `list()`
 * trusting `{ workflows }` — and it is what keeps this subpath's graph zod-free,
 * so a workflow app's page does not bundle a schema to read four fields. The
 * schema is on `@alexkroman1/aai/protocol` for a caller who wants it.
 */

import { apiFailure, readApiJson } from "./_workflow-api-envelope.ts";
import type { ClientConfigResponse } from "./client-config.ts";
import { CLIENT_CONFIG_PATH } from "./client-config-path.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { createWorkflowApiClient } from "./workflow-api-client.ts";
import type { WorkflowApi, WorkflowApiClientOptions } from "./workflow-api-types.ts";

// The shape `config()` resolves. Re-exported so one import path serves the whole
// client — the schema that parses it stays on `/protocol`, which is where a
// caller who wants to validate somebody else's answer should be.
export type { ClientConfigResponse } from "./client-config.ts";

/**
 * Everything one agent answers: every {@link WorkflowApi} call, plus the front
 * door.
 *
 * An intersection rather than a redeclaration — the workflow half must not be
 * describable twice.
 *
 * @public
 */
export type AgentClient = WorkflowApi & {
  /**
   * What the agent says it IS: `{ name?, greeting?, page?, sessionUrl? }`.
   *
   * The one read that works on EVERY agent, whatever shape it is, and the one a
   * caller starts with — `page` (absent reads as `"voice"`) is how you know
   * whether there is a session to open at all, and `sessionUrl` is the current
   * one. **Re-read it on every connect rather than storing it**: on the platform
   * it names the agent's sandbox, and that URL changes when the sandbox is
   * replaced by an idle reclaim or a redeploy.
   *
   * Unauthenticated on a deployed agent, exactly like the page it describes — so
   * this call works with no `token`, and a workflow API closed by
   * `AAI_WORKFLOW_API_TOKEN` does not close it.
   */
  config(): Promise<ClientConfigResponse>;
  /**
   * The agent's base URL, normalized — no trailing slash.
   *
   * Here because a caller that has this client should not also be threading the
   * string it was built from: a webhook to register, a link to print, a `curl`
   * to paste in a bug report all want it, and re-deriving it invites the
   * trailing-slash `//workflows` 404 this normalizes away.
   */
  readonly baseUrl: string;
};

/**
 * Create a client for one agent.
 *
 * Same options as {@link createWorkflowApiClient} — which agent, on whose
 * authority, and for how long — and the same advice: hoist it out of anything
 * that re-runs.
 *
 * @public
 */
export function createAgentClient(opts: WorkflowApiClientOptions): AgentClient {
  const workflows = createWorkflowApiClient(opts);
  // No trailing slash: `${base}/${path}` is how every URL here is built, and a
  // base that ends in one produces the `//client-config` a platform routing
  // `/:slug/client-config` answers 404.
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const auth: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};

  return {
    ...workflows,
    baseUrl,
    async config(): Promise<ClientConfigResponse> {
      // Built above the literal rather than spread into it: the guard is on the
      // BUDGET and the value is a signal, so `omitUndefined` is the spelling
      // this repo builds an optional property from (`guard-invariants` rule 2).
      const signal = opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs);
      const res = await fetch(`${baseUrl}/${CLIENT_CONFIG_PATH}`, {
        // The bearer is sent when there is one even though this route does not
        // require it: a self-hosted server sitting behind an authenticating
        // proxy is the case where it matters, and the route ignores it.
        headers: auth,
        // Same deadline the other reads take, and for the same reason: `fetch`
        // has none of its own, so a request issued while the platform is
        // restarting never settles and no error path ever runs. This read can be
        // waiting out a sandbox boot, which is what the caller's `timeoutMs`
        // budget is for.
        ...omitUndefined({ signal }),
      });
      if (!res.ok) throw await apiFailure(res);
      return await readApiJson<ClientConfigResponse>(res);
    },
  };
}
