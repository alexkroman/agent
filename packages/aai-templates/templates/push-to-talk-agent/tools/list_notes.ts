import { notebookSlot } from "../shared.ts";

/**
 * Read the notebook back. `notebookSlot.tool` rather than `updateTool`: this
 * writes nothing, and what a read is handed is frozen, so the declaration is
 * what says so.
 *
 * The notebook outlives the transcript the model is holding — a long session
 * trims early turns from the context window while the slot keeps every note —
 * so "what did I say about unit four?" is a lookup, not a memory.
 */
export default notebookSlot.tool({
  description: "List every note saved so far, oldest first, when the caller asks to hear them.",
  execute: (_args, notebook) => ({ notes: notebook.notes }),
});
