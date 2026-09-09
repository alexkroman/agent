import { createCodingTools } from "@alexkroman1/aai/coding-tools";

/**
 * Where the agent may read and write.
 *
 * Everything the tools do is resolved against this directory and nothing
 * outside it is reachable — a path that escapes is refused rather than
 * followed, whatever the model asks for. So this is the ONE line that decides
 * how much of the machine this agent can touch, and it is worth being
 * deliberate about it: point it at a project, a scratch checkout, or a
 * container's `/workspace`, and not at a home directory.
 *
 * `bash` is the reason to say that plainly. It runs whatever the model wrote
 * with the authority of this process — which is the same authority the write
 * and delete tools already have, so it grants nothing new; what it does is make
 * the grant obvious. Run this agent inside a container and treat the container
 * as the boundary.
 */
export const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? process.cwd();

/**
 * The agent's tools, built ONCE over {@link WORKSPACE_DIR}.
 *
 * A tool is normally a FILE — `agent()` takes no `tools` argument, and the
 * build enumerates `tools/`. These nine are files too (see the directory
 * beside this one), but each one re-exports an entry from this registry rather
 * than declaring a tool of its own, because every one of them closes over the
 * same directory: nine `createCodingTools` calls would be nine chances for one
 * of them to be pointed somewhere else.
 *
 * Three seams are worth knowing about before you extend this
 * (`CodingToolsOptions` carries the rest):
 *
 * - `validate` refuses a write BEFORE it lands — return a message and the file
 *   on disk is untouched. Parsing the content is the useful check: a file that
 *   does not parse cannot be edited back into shape by text matching, so
 *   writing it strands the turn.
 * - `afterWrite` appends to a write that SUCCEEDED, which is where a type
 *   checker or a linter's output belongs — the agent reads it inside the
 *   result of the write that caused it, and fixes it on the next step instead
 *   of discovering it a build later.
 * - `env` is what `bash` runs with. It defaults to this process's environment;
 *   hand it an allow-list when this agent is running somewhere that holds
 *   credentials it has no business reading.
 */
export const codingTools = createCodingTools({ dir: WORKSPACE_DIR });
