// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 15.
 *
 * Epoch 16 WIDENED `McpServerConfig`: `url` may be a resolver as well as a
 * literal, and `headers` and `allowedTools` joined it as optional fields
 * (with `McpResolvable` and `McpResolveContext`, the resolver's types). A
 * widened field is a break for a READER — code that took `config.url` to be a
 * `string` no longer type-checks — which is why the epoch moved. It is not one
 * for an AUTHOR: every server an epoch-15 agent declared, a literal URL, a
 * `tokenEnv` and a pin, is still a server, which is what this file proves.
 *
 * ## What this file has to name
 *
 * Epochs 13 and 14 were dropped, so this is the first retained example since
 * epoch 12 and it names everything epochs 13–15 added: the MCP declaration
 * written the way an epoch-15 author wrote it (a literal URL, a `tokenEnv`, a
 * pin), the key grammar and naming rule an author reads back, `routes` (with
 * `route()`'s checks, `routeError` and a Standard Webhooks route), the two
 * session-bracketing hooks, `endSession`, the phone-call and location readers,
 * `turnDetection` and `ModelTuning`. The rest of epoch 15's export list is
 * carried by the older retained examples.
 *
 * **Its specifiers are RELATIVE**, for the reason every frozen example's are.
 *
 * @module
 */

import type {
  AgentDef,
  AgentRoutes,
  AgentSessionLifecycle,
  EndSessionOptions,
  McpServerConfig,
  McpServers,
  ModelTuning,
  RouteContext,
  RouteDef,
  RouteHandler,
  RouteRequest,
  RouteResponse,
  SessionCall,
  SessionContext,
  SessionContextArgs,
  SessionEndContext,
  StandardWebhookOptions,
  TurnDetectionMode,
  ValidatedRouteRequest,
  WebhookRouteOptions,
} from "../../../index.ts";
import {
  agent,
  endSession,
  MCP_SERVER_KEY_RE,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  mcpToolName,
  RouteError,
  route,
  routeError,
  routeResponse,
  sessionCall,
  sessionClientLocation,
  verifyStandardWebhook,
  webhookRoute,
} from "../../../index.ts";

const docs: McpServerConfig = {
  url: "https://mcp.example.com/mcp",
  tokenEnv: "DOCS_MCP_TOKEN",
  pinnedTools: { search: "sha256-reviewed" },
};

const servers: McpServers = { docs };

const health: RouteHandler = (req: RouteRequest, ctx: RouteContext): RouteResponse =>
  routeResponse(200, { path: req.path, configured: ctx.env.DOCS_MCP_TOKEN !== undefined });

const whoami: RouteDef = {
  handler: (req: ValidatedRouteRequest<unknown, false>) => {
    if (req.clientId === undefined) throw routeError(404, "no client");
    return { client: req.clientId };
  },
};

const webhook: WebhookRouteOptions = { secretEnv: "DOCS_WEBHOOK_SECRET", toleranceS: 300 };
const replayWindow: StandardWebhookOptions = { toleranceS: 300 };

/** A delivery checked by hand, then refused the way `routeError` answers. */
const manual: RouteHandler = async (req, ctx) => {
  const ok = await verifyStandardWebhook(req, ctx.env.DOCS_WEBHOOK_SECRET ?? "", replayWindow);
  const refusal = ok ? undefined : routeError(401, "bad signature");
  return refusal instanceof RouteError ? routeResponse(refusal.status, {}) : routeResponse(200, {});
};

const routes: AgentRoutes["routes"] = {
  "GET /health": health,
  "GET /whoami": route(whoami),
  "POST /webhook": webhookRoute(webhook, () => ({ received: true })),
  "POST /webhook/manual": manual,
};

const lifecycle: AgentSessionLifecycle = {
  sessionContext: (args: SessionContextArgs): SessionContext => ({
    instructions: args.clientId ? `Returning caller ${args.clientId}.` : "New caller.",
  }),
  onSessionEnd: (end: SessionEndContext) => end.lastEventIndex,
};

const tuning: ModelTuning = { temperature: 0.2 };
const turnDetection: TurnDetectionMode = "auto";

/** An epoch-15 agent: one literal MCP server, its token by NAME, a reviewed pin. */
export const support: AgentDef = agent({
  name: "Support",
  mcpServers: servers,
  requiredEnv: ["DOCS_MCP_TOKEN"],
  routes,
  ...lifecycle,
  ...tuning,
  turnDetection,
});

/** What an epoch-15 tool read off its session, and how it hung up. */
export function hangUp(ctx: { sessionId: string }): string {
  const call: SessionCall | undefined = sessionCall(ctx);
  const where = sessionClientLocation(ctx) ?? "unknown";
  const options: EndSessionOptions = { afterReply: true };
  return `${call?.carrier ?? "web"} ${where} ${endSession(ctx, options)}`;
}

/** What an epoch-15 author read back: the key grammar and the model-facing name. */
export const searchTool: string = MCP_SERVER_KEY_RE.test("docs")
  ? mcpToolName("docs", "search").slice(0, MCP_TOOL_NAME_MAX)
  : `${MCP_TOOL_PREFIX}invalid`;
