// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { toolNameOf } from "./_testing-tool-names.ts";
import { agent, tool } from "./define.ts";
import { roster } from "./roster.ts";
import { speaker } from "./speaker.ts";
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

  test("a ROSTER tool is named by `agent({ roster })`, under its key on the speaker's map", () => {
    // A persona's tool is minted under the speaker by `agent({ roster })`, never
    // discovered from a file: `deployedAgent` on such an agent throws "no
    // project files", and `virtual:aai/agent` records the same nothing. The
    // roster lowering is therefore what records it — importing `agent.ts` is
    // enough — so `run(billing.tools.lookup_invoice)` reaches the tool the way
    // a file's default export does.
    const lookupInvoice = tool({ description: "Look up an invoice", execute: () => "ok" });
    const billing = speaker({
      name: "billing",
      speaks: true,
      description: "Invoices and refunds",
      systemPrompt: "You are the billing desk.",
      tools: { lookup_invoice: lookupInvoice },
    });
    expect(() => toolNameOf(lookupInvoice)).toThrow(/no agent registered/);
    expect(agent({ name: "Desk", roster: roster([billing]) }).name).toBe("Desk");
    expect(toolNameOf(lookupInvoice)).toBe("lookup_invoice");
  });

  test("the remedy names both lowerings, and the inline def's lack of one", () => {
    const inline = tool({ description: "Built in a spec", execute: () => "ok" });
    expect(() => toolNameOf(inline)).toThrow(
      /speaker's `tools` \(a roster\) is named when `agent\(\{ roster \}\)` runs/,
    );
    expect(() => toolNameOf(inline)).toThrow(/never been lowered and has no name/);
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
