// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 6.
 *
 * **Epoch 7 is COLLATERAL.** The export list did not change. What moved is
 * `DialogSessionEventName`, the template-literal union of `@`-prefixed
 * SESSION events a state's `on` may name, which is derived from the session
 * event vocabulary and so gained `"@metrics.collected"` when the vocabulary
 * gained that frame. Every `@` key an epoch-6 dialog wrote is still a member;
 * a dialog below that pins a persona (epoch 6's own addition) and moves on the
 * hang-up compiles exactly as it did.
 *
 * `v4.ts` and `v5.ts` already name all fifteen of this capability's exports,
 * and epoch 6 added no name, so this file carries no roll-call — only the
 * epoch-6 shape the grown union lands in.
 *
 * **Its specifiers are RELATIVE**, for the reason every frozen example's are.
 *
 * @module
 */

import type { DialogSessionEventName } from "../../../index.ts";
import { dialog } from "../../../index.ts";

/** The hang-up, as an epoch-6 `on` key spells a SESSION event. */
const HANG_UP: DialogSessionEventName = "@session.timed-out";

/** Intake, then billing — a state pinning who is speaking, epoch 6's field. */
export const intake = dialog("intake", {
  initial: "identify",
  states: {
    identify: {
      instruction: "Ask for the account number.",
      on: { IDENTIFIED: "billing", [HANG_UP]: "abandoned" },
    },
    billing: {
      instruction: "Resolve the invoice question.",
      persona: "billing",
      on: { RESOLVED: "done", [HANG_UP]: "abandoned" },
    },
    done: { final: true },
    abandoned: { final: true },
  },
});
