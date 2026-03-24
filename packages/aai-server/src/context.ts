// Copyright 2025 the AAI authors. MIT license.

import type { AaiKvNamespace, AaiR2Bucket, AaiVectorizeIndex } from "./bindings.ts";
import type { AssetStore, DeployStore } from "./bundle_store_tigris.ts";
import type { KvStore } from "./kv.ts";
import type { AgentSlot } from "./sandbox.ts";
import type { ScopeKey } from "./scope_token.ts";
import type { ServerVectorStore } from "./vector.ts";

export type Env = {
  Bindings: {
    slots: Map<string, AgentSlot>;
    deployStore: DeployStore;
    assetStore: AssetStore;
    scopeKey: ScopeKey;
    kvStore: KvStore;
    vectorStore?: ServerVectorStore | undefined;

    // CF-shaped bindings (backed by external services on Fly.io)
    KV: AaiKvNamespace;
    BUCKET: AaiR2Bucket;
    VECTORIZE?: AaiVectorizeIndex | undefined;
  };
  Variables: {
    slug: string;
    keyHash: string;
    scope: import("./scope_token.ts").AgentScope;
  };
};
