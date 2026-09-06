/**
 * `respond` — one of the four answers to a proposal, their `HumanResponse`
 * `"respond"`. The four live together in `../review.ts` because they share the one
 * place anything is sent and the reflection scope table; this file is what
 * gives this one its name.
 */

import { respondTool } from "../review.ts";

export default respondTool();
