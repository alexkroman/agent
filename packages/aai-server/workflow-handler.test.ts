// Copyright 2026 the AAI authors. MIT license.
/**
 * `/:slug/workflows/*` — the brokered workflow API.
 *
 * The route exists for ONE caller that cannot be simulated by talking to the
 * guest directly: a static agent's page, served by this platform at
 * `GET /:slug/`, which builds every request URL from `location`. So the specs
 * below assert the two halves that were missing when a deployed
 * `transcription-desk` answered `Could not start: Not found` — that the path
 * routes at all, and that what reaches the guest is the request the page made.
 */
import { describe, expect, test } from "vitest";
import { createSlotCache } from "./sandbox-slots.ts";
import { createTestOrchestrator, seedResidentSandbox } from "./test-utils.ts";

/** Records what the proxy forwarded, so a spec can assert on the guest's view. */
type Forwarded = {
  url: string;
  method: string;
  /** `null` when the header was not forwarded — which several specs assert. */
  auth: string | null;
  type: string | null;
  body: string;
};

function recordingGuest(
  seen: Forwarded[],
  respond: () => Response,
): { guestWorkflowFetch: typeof globalThis.fetch } {
  return {
    guestWorkflowFetch: async (input, init) => {
      const req = new Request(input, init);
      seen.push({
        url: req.url,
        method: req.method,
        auth: req.headers.get("authorization"),
        type: req.headers.get("content-type"),
        body: await req.text(),
      });
      return respond();
    },
  };
}

describe("handleAgentWorkflows", () => {
  test("returns 404 for a slug with no agent", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/no-agent/workflows/runs", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });

  test("forwards POST /runs to the brokered guest and returns its answer", async () => {
    const slots = createSlotCache();
    const seen: Forwarded[] = [];
    const { fetch, store } = await createTestOrchestrator({
      slots,
      ...recordingGuest(seen, () => Response.json({ runId: "run_123" })),
    });
    await seedResidentSandbox(fetch, store, slots, "my-agent");

    const res = await fetch("/my-agent/workflows/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "transcribe", input: { blobIds: ["b1"] } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run_123" });
    // Scheme swapped ws→http, the platform's `/:slug` prefix stripped, and the
    // sub-path preserved — the guest must see the path IT serves, not ours.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://tunnel.test/workflows/runs");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.type).toBe("application/json");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      workflow: "transcribe",
      input: { blobIds: ["b1"] },
    });
  });

  test("forwards a blob upload's raw body and content type", async () => {
    // The upload is the request the whole route exists for: bytes may not
    // travel in a journaled run input, so the page POSTs them here first.
    const slots = createSlotCache();
    const seen: Forwarded[] = [];
    const { fetch, store } = await createTestOrchestrator({
      slots,
      ...recordingGuest(seen, () => Response.json({ blobId: "blob_1", bytes: 4 })),
    });
    await seedResidentSandbox(fetch, store, slots, "my-agent");

    const res = await fetch("/my-agent/workflows/blobs", {
      method: "POST",
      headers: { "Content-Type": "audio/pcm" },
      body: "PCM!",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ blobId: "blob_1", bytes: 4 });
    expect(seen[0]?.url).toBe("https://tunnel.test/workflows/blobs");
    expect(seen[0]?.type).toBe("audio/pcm");
    expect(seen[0]?.body).toBe("PCM!");
  });

  test("forwards GET /runs/:id, its query string, and the bearer", async () => {
    // The bearer is the guest's own AAI_WORKFLOW_API_TOKEN gate; dropping it
    // would make every request to a closed agent a 401 with no way to pass.
    const slots = createSlotCache();
    const seen: Forwarded[] = [];
    const { fetch, store } = await createTestOrchestrator({
      slots,
      ...recordingGuest(seen, () => Response.json({ runId: "run_123", status: "running" })),
    });
    await seedResidentSandbox(fetch, store, slots, "my-agent");

    const res = await fetch("/my-agent/workflows/runs/run_123?verbose=1", {
      headers: { Authorization: "Bearer wf-token" },
    });

    expect(res.status).toBe(200);
    expect(seen[0]?.url).toBe("https://tunnel.test/workflows/runs/run_123?verbose=1");
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.auth).toBe("Bearer wf-token");
  });

  test("lists workflows at the bare /workflows path", async () => {
    // The one route whose path has no suffix — a proxy that only matched
    // `/workflows/:path` would 404 exactly here and nowhere else.
    const slots = createSlotCache();
    const seen: Forwarded[] = [];
    const { fetch, store } = await createTestOrchestrator({
      slots,
      ...recordingGuest(seen, () => Response.json({ workflows: [{ name: "transcribe" }] })),
    });
    await seedResidentSandbox(fetch, store, slots, "my-agent");

    const res = await fetch("/my-agent/workflows");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflows: [{ name: "transcribe" }] });
    expect(seen[0]?.url).toBe("https://tunnel.test/workflows");
  });

  test("passes the guest's error status and body through unchanged", async () => {
    // An unknown workflow names the declared ones and a bad input names the
    // schema issues — that text IS the diagnostic the page renders, so
    // replacing it with a platform-shaped error would be a real regression.
    const slots = createSlotCache();
    const seen: Forwarded[] = [];
    const { fetch, store } = await createTestOrchestrator({
      slots,
      ...recordingGuest(seen, () =>
        Response.json({ error: 'Unknown workflow "nope". Declared: transcribe' }, { status: 400 }),
      ),
    });
    await seedResidentSandbox(fetch, store, slots, "my-agent");

    const res = await fetch("/my-agent/workflows/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "nope" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown workflow "nope". Declared: transcribe' });
  });

  test("an unreachable guest is a retryable 503, not a 500", async () => {
    // The sandbox was ready a moment ago, so this is one that went away
    // between the broker and the forward — the page polls and should retry.
    const slots = createSlotCache();
    const { fetch, store } = await createTestOrchestrator({
      slots,
      guestWorkflowFetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await seedResidentSandbox(fetch, store, slots, "my-agent");

    const res = await fetch("/my-agent/workflows/runs", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
  });
});
