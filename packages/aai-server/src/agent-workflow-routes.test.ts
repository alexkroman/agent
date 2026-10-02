// Copyright 2026 the AAI authors. MIT license.
/**
 * The route INVENTORY and its body limits. Each handler's own behaviour is in
 * its own spec; what lives here is what this module decides — which paths are
 * mounted, under which verbs, and that an oversized body is refused before any
 * handler (or a sandbox boot) runs.
 */

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createTestStore } from "./_orchestrator-test-utils.ts";
import { registerAgentWorkflowRoutes } from "./agent-workflow-routes.ts";
import type { HonoEnv } from "./context.ts";
import { GUEST_ROUTE_EXPOSURE, GUEST_ROUTES } from "./guest/routes.ts";
import { SESSION_STATE_ROUTE } from "./guest-handlers/session-state.ts";
import { UPLOAD_RECORDS_ROUTE } from "./guest-handlers/uploads.ts";
import {
  MAX_ENQUEUE_BODY_BYTES,
  WORKFLOW_ENQUEUE_ROUTE,
} from "./guest-handlers/workflow-enqueue.ts";
import {
  WORKFLOW_JOURNAL_METHOD_ROUTE,
  WORKFLOW_JOURNAL_ROUTE,
} from "./guest-handlers/workflow-journal.ts";
import { WORKFLOW_KEYS_ROUTE } from "./guest-handlers/workflow-keys.ts";
import { createSlotCache } from "./sandbox/slots.ts";
import { createMemoryUploadBytes } from "./upload-bytes.ts";
import { UPLOAD_BYTES_METHODS, UPLOAD_BYTES_ROUTE } from "./upload-handler.ts";
import { WORKFLOW_WEBHOOK_ROUTE } from "./workflow-webhook-handler.ts";

function mounted(): Hono<HonoEnv> {
  const agents = new Hono<HonoEnv>();
  const store = createTestStore();
  registerAgentWorkflowRoutes(agents, {
    broker: { slots: createSlotCache(), store },
    uploadBytes: createMemoryUploadBytes(),
  });
  return agents;
}

/** The verbs the router answers on `path` (Hono records `ALL` middleware separately). */
function methodsOn(agents: Hono<HonoEnv>, path: string): string[] {
  return [
    ...new Set(
      agents.routes.filter((r) => r.path === path && r.method !== "ALL").map((r) => r.method),
    ),
  ].sort();
}

describe("registerAgentWorkflowRoutes", () => {
  test("the guest→platform routes are POST only", () => {
    const agents = mounted();
    for (const path of [
      WORKFLOW_ENQUEUE_ROUTE,
      SESSION_STATE_ROUTE,
      WORKFLOW_JOURNAL_ROUTE,
      WORKFLOW_JOURNAL_METHOD_ROUTE,
      WORKFLOW_KEYS_ROUTE,
      UPLOAD_RECORDS_ROUTE,
    ]) {
      expect.soft(methodsOn(agents, path), path).toEqual(["POST"]);
    }
  });

  test("the brokered routes take their verbs from the exposure declaration", () => {
    const agents = mounted();
    expect(methodsOn(agents, WORKFLOW_WEBHOOK_ROUTE)).toEqual(
      [...GUEST_ROUTE_EXPOSURE.workflowWebhook.methods].sort(),
    );
    const workflows = [...GUEST_ROUTE_EXPOSURE.workflows.methods].sort();
    expect(methodsOn(agents, GUEST_ROUTES.workflows)).toEqual(workflows);
    expect(methodsOn(agents, `${GUEST_ROUTES.workflows}/:path{.+}`)).toEqual(workflows);
  });

  test("the upload byte route answers its own verbs", () => {
    expect(methodsOn(mounted(), UPLOAD_BYTES_ROUTE)).toEqual([...UPLOAD_BYTES_METHODS].sort());
  });

  test("an oversized body is a 413 with a JSON reason, before the handler runs", async () => {
    const body = "x".repeat(MAX_ENQUEUE_BODY_BYTES + 1);
    const res = await mounted().request(WORKFLOW_ENQUEUE_ROUTE, {
      method: "POST",
      body,
      headers: { "content-length": String(body.length) },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body too large" });
  });
});
