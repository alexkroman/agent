// Copyright 2025 the AAI authors. MIT license.

import type { Context } from "hono";
import type { Storage } from "unstorage";
import type { BundleStore } from "./bundle-store.ts";

export type Env = {
  Bindings: {
    slots: Map<string, import("./sandbox.ts").AgentSlot>;
    store: BundleStore;
    storage: Storage;
  };
  Variables: {
    slug: string;
    keyHash: string;
  };
};

/** Typed context for route handlers using the platform {@link Env}. */
export type AppContext = Context<Env>;
