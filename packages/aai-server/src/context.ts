// Copyright 2025 the AAI authors. MIT license.

import type { Storage } from "unstorage";
import type { BundleStore } from "./bundle-store.ts";

export type Env = {
  Bindings: {
    slots: Map<string, import("./sandbox.ts").AgentSlot>;
    store: BundleStore;
    storage: Storage;
    modelCacheDir?: string;
  };
  Variables: {
    slug: string;
    keyHash: string;
  };
};
