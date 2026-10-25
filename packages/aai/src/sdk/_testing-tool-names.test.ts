// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { toolNameOf } from "./_testing-tool-names.ts";
import { agent, tool } from "./define.ts";
import { deployedAgent } from "./testing-discovery.ts";

const addItem = tool({
  description: "Add an item",
  inputSchema: z.object({ item: z.string() }),
  execute: ({ item }) => ({ added: item }),
});

describe("toolNameOf", () => {
  test("answers the file name a deployed agent registered the def under", () => {
    // The lowering is what records the pairing: the def is the file's default
    // export, and the name is the file's.
    deployedAgent(agent({ name: "Shop" }), {
      tools: { "./tools/add_item.ts": { default: addItem } },
    });
    expect(toolNameOf(addItem)).toBe("add_item");
  });

  test("a def no deployed agent registered throws naming the remedy", () => {
    const inline = tool({ description: "Built in a spec", execute: () => "ok" });
    expect(() => toolNameOf(inline)).toThrow(/import it as `virtual:aai\/agent`/);
    // WHICH tool, so a spec driving several knows which import it forgot.
    expect(() => toolNameOf(inline)).toThrow('described as "Built in a spec"');
  });

  test("the same def lowered again under another name answers the LAST name", () => {
    deployedAgent(agent({ name: "Shop" }), {
      tools: { "./tools/add_item.ts": { default: addItem } },
    });
    deployedAgent(agent({ name: "Kiosk" }), {
      tools: { "./tools/add_to_cart.ts": { default: addItem } },
    });
    expect(toolNameOf(addItem)).toBe("add_to_cart");
  });
});
