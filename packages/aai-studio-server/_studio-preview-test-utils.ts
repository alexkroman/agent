// Copyright 2026 the AAI authors. MIT license.
/**
 * Fixtures shared by the two preview suites — `studio-preview.test.ts` (the
 * "landing on a project" half: slug derivation, sandbox warm-up, the wake) and
 * `studio-preview-deploy.test.ts` (the deploy loop and its durable queue).
 *
 * Shared rather than duplicated because both halves talk about the same
 * project: a drifting SCOPE/PROJECT pair between them would make the two files
 * describe two different tenants while reading identically.
 */

import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { vi } from "vitest";

export const SCOPE = "scope";
export const PROJECT = "contact-form-x7k2mq";
export const TARGET = { serverUrl: "https://platform.example", apiKey: "caller-key" };

export function makeStore() {
  return createMemoryWorkspaceStore();
}

/** Wait for the fire-and-forget deploy loop to drain. */
export async function settled(): Promise<void> {
  await vi.waitFor(() => Promise.resolve());
  await new Promise((resolve) => setTimeout(resolve, 0));
}
