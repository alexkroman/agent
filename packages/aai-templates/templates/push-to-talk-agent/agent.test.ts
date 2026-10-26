import agentDef from "virtual:aai/agent";
import {
  createToolContext,
  expectDeployable,
  expectSlotContract,
} from "@alexkroman1/aai-runtime/testing";
import { describeAgent } from "@alexkroman1/aai-runtime/testing/vitest";
import { expect, test } from "vitest";
import { MAX_NOTES, notebookSlot } from "./shared.ts";
import listNotes from "./tools/list_notes.ts";
import saveNote from "./tools/save_note.ts";

/**
 * What this starter's spec may assert: properties that survive the edits the
 * template invites — renaming it, swapping a stage, rewording the prompt — on
 * the RESOLVED config, since `aai build` runs these before it bundles.
 *
 * The one thing it pins is the one thing the template is FOR: that the config
 * a deploy ships says `turnTaking: { detection: "manual" }`. Dropping that line leaves a
 * page whose button sends commands the agent ignores, while the transcriber
 * answers every pause — which looks like a working agent in a quiet room.
 */
describeAgent(agentDef, (run) => {
  test("the caller ends each turn, not the transcriber", () => {
    expect(expectDeployable(agentDef).turnTaking?.detection).toBe("manual");
  });

  test("both notebook tools are discovered from tools/", () => {
    // `toContain`, not an exact list: adding a file in `tools/` is the edit
    // this template most invites.
    expect(Object.keys(agentDef.tools ?? {})).toEqual(
      expect.arrayContaining(["save_note", "list_notes"]),
    );
  });

  test("save_note appends in order, and list_notes reads the same notebook back", async () => {
    // One context is one session: the two calls share a notebook.
    const ctx = createToolContext();
    await run(saveNote, { text: "Unit four: window seal cracked." }, ctx);
    await run(saveNote, { text: "  Boiler pressure reads one point two.  " }, ctx);
    const { notes } = await run(listNotes, ctx);
    expect(notes).toEqual([
      { id: 1, text: "Unit four: window seal cracked." },
      // Trimmed — a note is the caller's words, not the transcriber's padding.
      { id: 2, text: "Boiler pressure reads one point two." },
    ]);
    // The page reads the same notebook, newest first.
    expect(notebookSlot.projected(notebookSlot.get(ctx)).notes.map((note) => note.id)).toEqual([
      2, 1,
    ]);
  });

  test("the notebook is per session, and a full one keeps the newest notes", () => {
    expectSlotContract(notebookSlot, {
      write: (notebook) => {
        notebook.notes.push({ id: 1, text: "x" });
      },
    });
  });

  test("a full notebook never reuses an id", async () => {
    // `nextId` rather than `notes.length + 1`: once the cap trims the front, a
    // length-derived id would hand out a number a surviving note already has.
    const ctx = createToolContext();
    for (let i = 1; i <= MAX_NOTES + 3; i++) await run(saveNote, { text: `note ${i}` }, ctx);
    const { notes } = notebookSlot.get(ctx);
    expect(notes[0]?.id).toBe(4);
    expect(notes.at(-1)?.id).toBe(MAX_NOTES + 3);
  });
});
