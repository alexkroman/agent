// Copyright 2025 the AAI authors. MIT license.

import type { Context } from "hono";
import type { Storage } from "unstorage";
import type { BundleStore } from "./store-types.ts";

export type Env = {
  Bindings: {
    slots: import("./sandbox-slots.ts").SlotCache;
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

/** Context for handlers whose JSON body was pre-validated by `zValidator`. */
export type ValidatedAppContext<T> = Context<Env, string, { in: { json: T }; out: { json: T } }>;
