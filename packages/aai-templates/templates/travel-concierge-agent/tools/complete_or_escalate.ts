/**
 * `complete_or_escalate` — part of the dialog-stack control plane, which lives together in
 * `../routing.ts` because the four tools share its helpers. This file is what
 * gives it its name.
 */

import { completeOrEscalateTool } from "../routing.ts";

export default completeOrEscalateTool();
