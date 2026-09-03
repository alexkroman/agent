// Copyright 2026 the AAI authors. MIT license.
/**
 * A tool as a self-hosted agent's author writes one: a file under `tools/`,
 * named for what the model calls, default-exporting `tool({ … })`.
 *
 * Read by `tools-dir.test.ts` through `withToolsDir`, which is the only thing
 * that imports it — nothing here registers it.
 */

import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Roll a single die with the given number of sides.",
  inputSchema: z.object({ sides: z.number().int().min(2).max(1000) }),
  execute: ({ sides }) => ({ rolled: 1 + Math.floor(Math.random() * sides) }),
});
