// Copyright 2026 the AAI authors. MIT license.
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { type PhoneTree, walkPhoneTree } from "./phone-tree.ts";
import type { EvalTurn } from "./session-types.ts";

const TREE: PhoneTree = {
  name: "main",
  prompt: "For billing, press 1. For appointments, press 2.",
  options: {
    "1": { name: "billing", prompt: "Billing, this is Sam." },
    "2": {
      name: "extension",
      prompt: "Enter the extension, then pound.",
      options: { "204": { name: "front desk", prompt: "Front desk, this is Dana." } },
    },
  },
};

type Reply = { dtmf?: readonly string[] | undefined; endedSession?: boolean };

/** A `say()` that answers each line with the next scripted reply, and records what it heard. */
function scripted(replies: readonly Reply[]) {
  const heard: string[] = [];
  let at = 0;
  const say = async (text: string): Promise<EvalTurn> => {
    heard.push(text);
    const reply = replies[at++] ?? { dtmf: [] };
    return {
      text: "",
      events: [],
      toolCalls: [],
      completed: true,
      errors: [],
      endedSession: reply.endedSession ?? false,
      ...omitUndefined({ dtmf: reply.dtmf }),
    };
  };
  return { session: { say }, heard };
}

describe("walkPhoneTree", () => {
  test("follows the keys pressed to the leaf, and says the leaf's prompt last", async () => {
    const { session, heard } = scripted([{ dtmf: ["2"] }, { dtmf: ["204#"] }, { dtmf: [] }]);
    const walk = await walkPhoneTree(session, TREE);

    expect(walk.reached).toBe("front desk");
    expect(walk.stopped).toBeUndefined();
    expect(walk.path).toEqual([
      { menu: "main", pressed: "2", next: "extension" },
      { menu: "extension", pressed: "204#", next: "front desk" },
    ]);
    expect(heard).toEqual([
      "For billing, press 1. For appointments, press 2.",
      "Enter the extension, then pound.",
      "Front desk, this is Dana.",
    ]);
    expect(walk.turns).toHaveLength(3);
  });

  test("an entry split over presses, with pauses, is one entry", async () => {
    const { session } = scripted([{ dtmf: ["2"] }, { dtmf: ["20", "w4"] }, { dtmf: [] }]);
    const walk = await walkPhoneTree(session, TREE);
    expect(walk.path[1]).toEqual({ menu: "extension", pressed: "204", next: "front desk" });
  });

  test("a wrong key and a silent turn replay the menu, as a real one does", async () => {
    const { session, heard } = scripted([
      { dtmf: ["3"] },
      { dtmf: [] },
      { dtmf: ["1"] },
      { dtmf: [] },
    ]);
    const walk = await walkPhoneTree(session, TREE);

    expect(walk.reached).toBe("billing");
    expect(walk.path.map((step) => [step.pressed, step.next])).toEqual([
      ["3", undefined],
      ["", undefined],
      ["1", "billing"],
    ]);
    expect(heard[1]).toMatch(/^Sorry, that is not a valid option\. For billing/);
    expect(heard[2]).toMatch(/^Sorry, I didn't get your selection\. For billing/);
  });

  test("an entry is matched WHOLE: a stray second key is a wrong entry", async () => {
    const { session } = scripted([{ dtmf: ["21"] }]);
    const walk = await walkPhoneTree(session, TREE, { maxPrompts: 1 });
    expect(walk.path).toEqual([{ menu: "main", pressed: "21", next: undefined }]);
    expect(walk.stopped).toBe("max-prompts");
  });

  test("stops when the agent hangs up on the menu, saying so", async () => {
    const { session } = scripted([{ dtmf: [], endedSession: true }]);
    const walk = await walkPhoneTree(session, TREE);
    expect(walk).toMatchObject({ reached: undefined, stopped: "hung-up" });
    expect(walk.turns).toHaveLength(1);
  });

  test("a loop on a wrong key ends at maxPrompts rather than running forever", async () => {
    const { session, heard } = scripted(Array.from({ length: 20 }, () => ({ dtmf: ["9"] })));
    const walk = await walkPhoneTree(session, TREE, { maxPrompts: 4 });
    expect(walk.stopped).toBe("max-prompts");
    expect(heard).toHaveLength(4);
  });

  test("the leaf is said even when reaching it spent the last prompt", async () => {
    const { session, heard } = scripted([{ dtmf: ["1"] }, { dtmf: [] }]);
    const walk = await walkPhoneTree(session, TREE, { maxPrompts: 1 });
    expect(walk.reached).toBe("billing");
    expect(heard).toHaveLength(2);
  });

  test("a turn with no `dtmf` is a harness that cannot say, and throws naming the fix", async () => {
    const { session } = scripted([{ dtmf: undefined }]);
    await expect(walkPhoneTree(session, TREE)).rejects.toThrow(/carries no `dtmf`/);
  });

  test("a menu with no options is refused before anything is said", async () => {
    const { session, heard } = scripted([]);
    const tree: PhoneTree = { name: "dead end", prompt: "Goodbye.", options: {} };
    await expect(walkPhoneTree(session, tree)).rejects.toThrow(/"dead end" has no options/);
    expect(heard).toEqual([]);
  });
});
