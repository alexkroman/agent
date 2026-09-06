/**
 * `accept` — one of the four answers to a proposal, their `HumanResponse`
 * `"accept"`. The four live together in `../review.ts` because they share the one
 * place anything is sent and the reflection scope table; this file is what
 * gives this one its name.
 */

import { acceptTool } from "../review.ts";

export default acceptTool();
