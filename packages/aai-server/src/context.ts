// Copyright 2025 the AAI authors. MIT license.

import type { BundleStore } from "./bundle-store-tigris.ts";
import type { KvStore } from "./kv.ts";
import type { AgentSlot } from "./sandbox.ts";
import type { ScopeKey } from "./scope-token.ts";
import type { ServerVectorStore } from "./vector.ts";

export type Env = {
  Bindings: {
    slots: Map<string, AgentSlot>;
    store: BundleStore;
    scopeKey: ScopeKey;
    kvStore: KvStore;
    vectorStore?: ServerVectorStore | undefined;
  };
  Variables: {
    slug: string;
    keyHash: string;
    scope: import("./scope-token.ts").AgentScope;
  };
};
