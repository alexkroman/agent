// Copyright 2025 the AAI authors. MIT license.
/**
 * Type definitions for the agent bundle store (S3 in production, in-memory for tests).
 *
 * Separated from `bundle-store.ts` (which has the S3 implementation) so that
 * test utilities and handlers can depend on the interface without pulling in
 * AWS SDK imports.
 */

import type { IsolateConfig } from "./rpc-schemas.ts";
import type { AgentMetadata } from "./schemas.ts";

export type BundleStore = {
  putAgent(bundle: {
    slug: string;
    env: Record<string, string>;
    worker: string;
    clientFiles: Record<string, string>;
    credential_hashes: string[];
    /** Pre-extracted agent config from CLI build. */
    agentConfig: IsolateConfig;
  }): Promise<void>;
  getManifest(slug: string): Promise<AgentMetadata | null>;
  getWorkerCode(slug: string): Promise<string | null>;
  getClientFile(slug: string, filePath: string): Promise<string | null>;
  deleteAgent(slug: string): Promise<void>;
  getEnv(slug: string): Promise<Record<string, string> | null>;
  putEnv(slug: string, env: Record<string, string>): Promise<void>;
  /** Retrieve the pre-extracted agent config. */
  getAgentConfig(slug: string): Promise<IsolateConfig | null>;
};
