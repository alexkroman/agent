// Copyright 2025 the AAI authors. MIT license.
/**
 * Type definitions for the agent bundle store.
 *
 * Separated from `bundle-store.ts` (which has the blob/row implementation)
 * so that test utilities and handlers can depend on the interface without
 * pulling in storage imports.
 */

import type { AgentRecord } from "./agent-store.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";

export type BundleStore = {
  /**
   * Persist a deploy: content-addressed blobs first (worker, client files),
   * env to the SecretStore, then the agents-row upsert — the atomic commit
   * point that makes the new deploy visible and bumps `version`.
   */
  putAgent(bundle: {
    slug: string;
    env: Record<string, string>;
    worker: string;
    clientFiles: Record<string, string>;
    credential_hashes: string[];
    /** Pre-extracted agent config from the CLI build. */
    agentConfig: IsolateConfig;
    /**
     * The harness snapshot image tag this deploy runs against (see
     * `currentHarnessImageTag` in sandbox-vm.ts). Null outside the Modal
     * backend.
     */
    harnessImageTag?: string | null | undefined;
  }): Promise<void>;
  /** The deploy record: ownership hashes, config, blob hashes, version. */
  getAgent(slug: string): Promise<AgentRecord | null>;
  /**
   * Current deploy version, or null when the agent does not exist. The
   * cross-replica invalidation signal resident sandboxes are checked
   * against — cached much more briefly than `getAgent`.
   */
  getAgentVersion(slug: string): Promise<number | null>;
  getWorkerCode(slug: string): Promise<string | null>;
  /**
   * A time-boxed read URL for the slug's worker blob, for a guest to fetch
   * its own bundle with (see `BlobStorage.signedUrl`). Null for an unknown
   * agent, or a blob backend that cannot sign (the memory store — local dev
   * and tests, where {@link getWorkerCode} is the only path); a signing
   * FAILURE throws.
   *
   * Deliberately NOT cached: the URL expires, so a cached one is a boot
   * failure waiting for the TTL to lapse. The blob it points at is immutable,
   * which is what makes minting a fresh URL per spawn cheap (one API call, no
   * bytes).
   */
  getWorkerUrl(slug: string, ttlSeconds: number): Promise<string | null>;
  getClientFile(slug: string, filePath: string): Promise<string | null>;
  deleteAgent(slug: string): Promise<void>;
  getEnv(slug: string): Promise<Record<string, string> | null>;
  putEnv(slug: string, env: Record<string, string>): Promise<void>;
  /**
   * Drop this replica's read-through row caches for `slug`, so the next
   * read sees another replica's mutation. Blob caches are content-addressed
   * and immutable — they never need invalidation.
   */
  invalidate?(slug: string): void;
};
