// Copyright 2026 the AAI authors. MIT license.
/**
 * Control-channel JSON-RPC dispatch — studio mode's `/ws` only.
 *
 * Split out of `harness.ts` when that file reached the 500-line cap, and along
 * the line the file's own section banners already drew: this is what the host
 * can ASK the guest to do, while `harness.ts` is the process — the two servers,
 * the lazy runtime facade, mode selection. The wire params arrive as `unknown`,
 * so Zod at the receiving site is the contract, and each schema lives next to
 * its handler and validates EVERY field that handler forwards.
 */

import { errorMessage } from "@alexkroman1/aai";
import { formatSchemaIssues } from "@alexkroman1/aai/internal";
import { z } from "zod";
import type { HarnessState } from "./harness-bundle.ts";
import { handleHostResponse, sendError, sendResponse } from "./harness-rpc.ts";
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./harness-types.ts";
import { withBuildDir } from "./studio-build.ts";
import { initStudioSession } from "./studio-chat.ts";
import { deployWorkspaceDir } from "./studio-publish.ts";
import { SessionInitParamsSchema } from "./studio-session-init.ts";
import { materializeWorkspace } from "./studio-workspace-fs.ts";

const DeployParamsSchema = z.object({
  files: z.record(z.string(), z.string()),
  serverUrl: z.string(),
  apiKey: z.string(),
  slug: z.string().optional(),
  /**
   * Auto-preview deploys only — see `deployWorkspaceDir`. Additive and
   * optional, so an older host that never sends it still publishes (absent
   * reads as "production", the safe default).
   */
  allowPreviewSlug: z.boolean().optional(),
});

/** Resolve and settle a single incoming JSON-RPC request. */
export async function handleRequest(req: JsonRpcRequest, state: HarnessState): Promise<void> {
  switch (req.method) {
    // Publish: run `aai deploy` IN THIS SANDBOX against a materialized
    // snapshot of the workspace (see studio-publish.ts) — the literal CLI,
    // so studio publishes and laptop deploys are one path, and the CLI's
    // output rides back for the chat.
    case "workspace/deploy": {
      const parsed = DeployParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        sendError(
          req.id,
          -32_602,
          `workspace/deploy: invalid params — ${formatSchemaIssues(parsed.error.issues)}`,
        );
        break;
      }
      const { files, serverUrl, apiKey, slug, allowPreviewSlug } = parsed.data;
      const result = await withBuildDir(files, materializeWorkspace, (dir) =>
        deployWorkspaceDir(dir, { serverUrl, apiKey, slug, allowPreviewSlug }),
      );
      sendResponse(req.id, result);
      break;
    }

    case "studio/session-init": {
      const parsed = SessionInitParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        sendError(
          req.id,
          -32_602,
          `studio/session-init: invalid params — ${formatSchemaIssues(parsed.error.issues)}`,
        );
        break;
      }
      state.studio = await initStudioSession(parsed.data);
      sendResponse(req.id, { ok: true });
      break;
    }

    default:
      sendError(req.id, -32_601, `Method not found: ${req.method}`);
  }
}

export function handleNotification(notif: JsonRpcNotification): void {
  // The frame came off the wire — a malformed notification with no string
  // `method` must be ignored, not allowed to throw and kill the handler.
  if (typeof notif?.method !== "string") return;
  if (notif.method === "shutdown") process.exit(0);
}

export function dispatchMessage(msg: JsonRpcMessage, state: HarnessState): void {
  // Incoming response to a host RPC request we sent (studio sync/persist)
  if ("id" in msg && !("method" in msg)) {
    handleHostResponse(msg as JsonRpcResponse);
    return;
  }
  // Notification (no id)
  if (!("id" in msg)) {
    handleNotification(msg as JsonRpcNotification);
    return;
  }
  // Request — handle concurrently so the socket keeps draining.
  const req = msg as JsonRpcRequest;
  void handleRequest(req, state).catch((err) => {
    sendError(req.id, -32_603, errorMessage(err));
  });
}
