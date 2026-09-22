import { sessionSlot } from "@alexkroman1/aai";

/** One dictated note, as the notebook panel renders it. */
export type Note = { id: number; text: string };

/**
 * The most notes one session keeps.
 *
 * The notebook rides every `syncState` frame, so an unbounded list is a frame
 * that grows for as long as the call lasts. Fifty is a long walk-through of a
 * site; older than that belongs in a real document.
 */
export const MAX_NOTES = 50;

/**
 * The session's notebook — the agent's own state, so a reload resumes with
 * every note still there.
 *
 * `nextId` rather than `notes.length + 1`: `caps` trims the FRONT of the list
 * once it is full, and a length-derived id would then hand out a number a
 * surviving note already has.
 */
export const notebookSlot = sessionSlot("notebook", () => ({ notes: [] as Note[], nextId: 1 }), {
  caps: { notes: MAX_NOTES },
});

/**
 * What the browser sees — the projection BOTH ends use (`syncState` in
 * `agent.ts`, `useAgentState` in `client.tsx`), newest first because that is
 * how the panel reads best. The slot itself stays chronological.
 */
export const notebookProjection = notebookSlot.projection((notebook) => ({
  notes: [...notebook.notes].reverse(),
}));
