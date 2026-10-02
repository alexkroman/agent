// Copyright 2026 the AAI authors. MIT license.
/**
 * The event-log half of the session-state case list, over a FRESH reference
 * backend per case — the opposite of the memory arm in `conformance.test.ts`,
 * which shares one. Green under both is the claim that no case leans on
 * another's leftovers.
 */

import { createMemoryStateBackend } from "./backends/memory.ts";
import { sessionStateEventConformance } from "./conformance-events.ts";
import { sessionStateIds } from "./conformance-slots.ts";

sessionStateEventConformance({
  label: "memory, fresh per case",
  backend: () => createMemoryStateBackend(),
  uid: sessionStateIds("events-fresh"),
});
