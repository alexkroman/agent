// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `procedure`.
 *
 * Running a state machine to completion as ONE unit of work inside a tool call
 * — the sibling of `dialog`, and a separate capability for the same reason they
 * are separate primitives: a dialog is where a conversation IS (persisted, moved
 * by the caller's turns) and a procedure is one piece of work (never stored, driving
 * itself through invoked actors). An author picks between them, so a signature
 * change in one says nothing about the other.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type Procedure,
  ProcedureNotFinishedError,
  type ProcedureRunOptions,
  procedure,
} from "../../index.ts";
