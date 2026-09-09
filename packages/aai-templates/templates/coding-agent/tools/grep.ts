import { codingTools } from "../shared.ts";

// A tool is its FILE, so the name the model calls is this file's name. The
// definition itself is one entry of the shared registry — see `../shared.ts`
// for why all nine are built together rather than one per file.
export default codingTools.grep;
