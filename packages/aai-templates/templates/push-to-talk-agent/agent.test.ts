/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import { createToolContext, expectDeployable, toolRunner } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { MAX_NOTES, notebookProjection, notebookSlot } from "./shared.ts";

/**
 * What this starter's spec may assert: properties that survive the edits the
 * template invites — renaming it, swapping a stage, rewording the prompt — on
 * the RESOLVED config, since `aai build` runs these before it bundles.
 *
 * The one thing it pins is the one thing the template is FOR: that the config
 * a deploy ships says `turnDetection: "manual"`. Dropping that line leaves a
 * page whose button sends commands the agent ignores, while the transcriber
 * answers every pause — which looks like a working agent in a quiet room.
 */
const run = toolRunner(agentDef);

describe("push-to-talk-agent template", () => {
  test("is deployable: validates, is nameable, and every stage its mode needs is filled", () => {
    expect(() => expectDeployable(agentDef)).not.toThrow();
  });

  test("the caller ends each turn, not the transcriber", () => {
    expect(expectDeployable(agentDef).turnDetection).toBe("manual");
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
    await run("save_note", { text: "Unit four: window seal cracked." }, ctx);
    await run("save_note", { text: "  Boiler pressure reads one point two.  " }, ctx);
    const listed = await run("list_notes", {}, ctx);
    expect(listed).toEqual({
      notes: [
        { id: 1, text: "Unit four: window seal cracked." },
        // Trimmed — a note is the caller's words, not the transcriber's padding.
        { id: 2, text: "Boiler pressure reads one point two." },
      ],
    });
    // The page reads the same notebook, newest first.
    expect(notebookProjection(notebookSlot.get(ctx)).notes.map((note) => note.id)).toEqual([2, 1]);
  });

  test("a full notebook keeps the newest notes and never reuses an id", async () => {
    const ctx = createToolContext();
    for (let i = 1; i <= MAX_NOTES + 3; i++) await run("save_note", { text: `note ${i}` }, ctx);
    const { notes } = notebookSlot.get(ctx);
    expect(notes).toHaveLength(MAX_NOTES);
    expect(notes[0]?.id).toBe(4);
    expect(notes.at(-1)?.id).toBe(MAX_NOTES + 3);
  });
});
