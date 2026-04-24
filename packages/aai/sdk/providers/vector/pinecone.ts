// Copyright 2026 the AAI authors. MIT license.
/**
 * Pinecone vector store factory — returns a pure descriptor.
 *
 * Pinecone's REST API works through the gVisor sandbox host fetch proxy. The
 * resolver in `host/providers/resolve.ts` reads `PINECONE_API_KEY` from the
 * agent's env and lazy-imports `@pinecone-database/pinecone` when the
 * descriptor is opened. The index host (`*.svc.<env>.pinecone.io` or the
 * cluster URL when supplied as `indexHost`) is auto-added to the sandbox
 * `allowedHosts`.
 */

import type { VectorProvider } from "../../providers.ts";

export const PINECONE_KIND = "pinecone" as const;

export interface PineconeOptions {
  /** Pinecone index name. Required. */
  index: string;
  /**
   * Optional default namespace. Per-call namespace in `query`/`upsert`/
   * `delete`/`fetch` overrides this.
   */
  namespace?: string;
  /**
   * Optional index host URL (e.g. `https://my-index-abc.svc.aped-4627-b74a.pinecone.io`).
   * If omitted, the SDK looks it up via the control plane on first use. Set
   * this when running inside the sandbox so the host can be allowlisted
   * up-front.
   */
  indexHost?: string;
  /** API key. Defaults to `process.env.PINECONE_API_KEY`. */
  apiKey?: string;
}

export type PineconeProvider = VectorProvider & {
  readonly kind: typeof PINECONE_KIND;
  readonly options: PineconeOptions;
};

export function pinecone(opts: PineconeOptions): PineconeProvider {
  return { kind: PINECONE_KIND, options: { ...opts } };
}
