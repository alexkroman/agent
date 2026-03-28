// Copyright 2025 the AAI authors. MIT license.

import type { Context } from "hono";
import { createFactory } from "hono/factory";
import type { Env } from "./context.ts";

export const factory = createFactory<Env>();

/** Typed context for route handlers using the platform {@link Env}. */
export type AppContext = Context<Env>;
