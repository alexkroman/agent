import { z } from "zod";
import { notebookSlot } from "../shared.ts";

/**
 * Write one note. `updateTool`, because it writes: the body gets a mutable
 * draft of the notebook and whatever it leaves is stored when it returns.
 *
 * The note is the caller's WHOLE held turn. Under `turnDetection: "manual"`
 * the transcript the model is handed spans every pause inside one press, so a
 * note dictated as "Unit four… (pause) …the window seal is cracked… (pause)
 * …needs replacing before winter" arrives as one sentence rather than three
 * turns the agent tried to answer one at a time.
 */
export default notebookSlot.updateTool({
  description:
    "Save a note the caller dictated. Call it once per note, with the note as they said it, tidied only for punctuation.",
  inputSchema: z.object({
    text: z.string().min(1).describe("The note, in the caller's own words."),
  }),
  execute: ({ text }, notebook) => {
    const note = { id: notebook.nextId, text: text.trim() };
    notebook.nextId += 1;
    notebook.notes.push(note);
    return { saved: note.id, total: notebook.notes.length };
  },
});
