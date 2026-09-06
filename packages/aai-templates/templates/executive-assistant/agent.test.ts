/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";
import type { ToolContext } from "@alexkroman1/aai";
import { isToolFailure } from "@alexkroman1/aai";
import {
  createToolContext,
  expectDialogOk,
  expectToolOk,
  scriptedToolContext,
  stubGenerate,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import { DEFAULT_MEMORY, EXECUTIVE, INBOX } from "./inbox.ts";
import { calendarTool, weekdayOf } from "./meeting.ts";
import { reflect } from "./nodes.ts";
import {
  CHOOSE_MEMORY_SYSTEM,
  type MemoryType,
  REWRITE_SYSTEM,
  TRIAGE_SYSTEM,
  type TriageVerdict,
  UPDATE_MEMORY_SYSTEM,
} from "./prompts.ts";
import { propose } from "./review.ts";
import {
  AT_INBOX,
  AWAITING,
  assistantProjection,
  assistantSlot,
  assistantView,
  DRAFTING,
  reviewFlow,
  seedAssistant,
  similarExamples,
} from "./shared.ts";

// ─── Harness ─────────────────────────────────────────────────────────────────

const run = toolRunner(agentDef);

/** What a triager reading the seed would say — keyed by subject, so the stub
 *  really "reads" the email in the prompt rather than answering by position. */
const VERDICTS: Record<string, TriageVerdict["response"]> = {
  m1: "no",
  m2: "email",
  m3: "notify",
  m4: "email",
  m5: "no",
  m6: "email",
  m7: "email",
  m8: "email",
};

function verdictFor(prompt: string): TriageVerdict {
  const email = INBOX.find((e) => prompt.includes(`Subject: ${e.subject}`));
  const response = email ? VERDICTS[email.id] : undefined;
  if (!response) throw new Error("triage prompt names no seeded email");
  return { logic: `because it is ${email?.id}`, response };
}

/** The draft the rewriter was handed, read back out of its own prompt. */
function draftIn(prompt: string): string {
  return prompt.match(/<draft>\n([\s\S]*?)\n<\/draft>/)?.[1] ?? "";
}

/**
 * The model roles this template plays, routed by system prompt, plus the one
 * subagent. `chooser` is what the reflection's first step names; `update` is
 * what its second step answers for every type chosen.
 */
function scriptedDesk(
  opts: {
    chooser?: MemoryType[];
    update?: { logic: string; updatePrompt: boolean; newPrompt: string };
  } = {},
) {
  return scriptedToolContext({
    generate: {
      [TRIAGE_SYSTEM]: (call) => ({ object: verdictFor(call.prompt) }),
      [REWRITE_SYSTEM]: (call) => ({
        object: {
          toneLogic: "casual and direct",
          rewrittenContent: `(in Maya's voice) ${draftIn(call.prompt)}`,
        },
      }),
      [CHOOSE_MEMORY_SYSTEM]: { object: { memoryTypesToUpdate: opts.chooser ?? [] } },
      [UPDATE_MEMORY_SYSTEM]: {
        object: opts.update ?? { logic: "", updatePrompt: false, newPrompt: "" },
      },
    },
    delegate: {
      "meeting-assistant": {
        text: "Maya is free Wednesday 1pm-3pm.",
        steps: 3,
        toolCalls: [{ name: "get_events_for_days", input: { days: ["2026-03-17", "2026-03-18"] } }],
      },
    },
  });
}

const stateOf = (ctx: ToolContext) => assistantSlot.get(ctx);
const at = (ctx: ToolContext) => reviewFlow.position(ctx).state;
const openById = (id: string, ctx: ToolContext) => run("open_email", { id }, ctx);

// ─── 1. Triage ───────────────────────────────────────────────────────────────

describe("triage_inbox (their triage_input, over the whole inbox)", () => {
  test("asks the model once per email and routes every verdict", async () => {
    const { ctx, model } = scriptedDesk();
    const out = expectToolOk<{
      triaged: number;
      needReply: unknown[];
      headsUp: unknown[];
      filed: string[];
    }>(await run("triage_inbox", ctx));
    expect(out.triaged).toBe(INBOX.length);
    expect(model.calls.filter((c) => c.system === TRIAGE_SYSTEM)).toHaveLength(INBOX.length);
    expect(out.needReply).toHaveLength(5);
    expect(out.headsUp).toHaveLength(1);
    // Their `route_after_triage`: a `no` is marked read on the spot.
    expect(out.filed).toEqual([INBOX[0]?.subject, INBOX[4]?.subject]);
    const filed = stateOf(ctx).emails.filter((e) => e.closedAs === "filed");
    expect(filed.map((e) => e.id)).toEqual(["m1", "m5"]);
    expect(stateOf(ctx).emails.filter((e) => e.status === "queued")).toHaveLength(6);
    // Nothing was opened: triage is not a proposal.
    expect(at(ctx)).toBe(AT_INBOX);
  });

  test("a second run has nothing to triage and says so", async () => {
    const { ctx, model } = scriptedDesk();
    await run("triage_inbox", ctx);
    const again = expectToolOk<{ triaged: number }>(await run("triage_inbox", ctx));
    expect(again.triaged).toBe(0);
    expect(model.calls).toHaveLength(INBOX.length);
  });

  test("a settled email becomes a few-shot example for the next triage", async () => {
    // Their `save_email` → `get_few_shot_examples`: ignore one email, and the
    // next triage prompt carries it as a worked example with its verdict.
    const { ctx, model } = scriptedDesk();
    await openById("m2", ctx);
    await run("ignore", ctx);
    expect(stateOf(ctx).triageExamples).toEqual([
      expect.objectContaining({ emailId: "m2", result: "no" }),
    ]);
    await openById("m7", ctx);
    const last = model.calls.filter((c) => c.system === TRIAGE_SYSTEM).at(-1);
    expect(last?.prompt).toContain("Here are some previous examples");
    expect(last?.prompt).toContain("> Triage Result: no");
    expect(last?.prompt).toContain(INBOX[1]?.subject);
  });

  test("similarExamples ranks by overlap and caps at five", () => {
    const examples = INBOX.map((e) => ({
      emailId: e.id,
      subject: e.subject,
      from: e.from,
      excerpt: e.body,
      result: "email" as const,
    }));
    const picked = similarExamples(examples, {
      from: "sales@leadblast.co",
      subject: "Re: your outbound pipeline",
      body: "qualified demos with our AI SDR platform",
    });
    expect(picked).toHaveLength(5);
    expect(picked[0]?.emailId).toBe("m1");
  });
});

// ─── 2. Opening a thread ─────────────────────────────────────────────────────

describe("open_email (their graph's entry)", () => {
  test("opens the oldest email that needs a reply and hands back the brief", async () => {
    const { ctx } = scriptedDesk();
    await run("triage_inbox", ctx);
    const opened = expectDialogOk<{ route: string; email: { id: string }; instructions: string }>(
      await run("open_email", ctx),
    );
    expect(opened.result.route).toBe("draft");
    expect(opened.result.email.id).toBe("m2");
    expect(opened.state).toBe(DRAFTING);
    // The brief IS the result — their EMAIL_WRITING_INSTRUCTIONS with memory in it.
    expect(opened.result.instructions).toContain("draft_reply");
    expect(opened.result.instructions).toContain("Priya");
    expect(stateOf(ctx).openId).toBe("m2");
    expect(stateOf(ctx).exchange[0]).toMatch(/^Draft a response to this email:/);
  });

  test("replies come before heads-ups, oldest first", async () => {
    const { ctx } = scriptedDesk();
    await run("triage_inbox", ctx);
    const order: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const opened = expectToolOk<{ email: { id: string } }>(await run("open_email", ctx));
      order.push(opened.email.id);
      await run("ignore", ctx);
    }
    // m3 is the heads-up: older than m4, and still last.
    expect(order).toEqual(["m2", "m4", "m6", "m7", "m8", "m3"]);
    expect(await run("open_email", ctx)).toMatchObject({
      error: expect.stringContaining("Nothing is queued"),
    });
  });

  test("a heads-up goes straight to the executive with only ignore and respond", async () => {
    // Their `route_after_triage`: notify → human_node, no drafting.
    const { ctx } = scriptedDesk();
    const opened = expectDialogOk<{ route: string; allowed: string[] }>(await openById("m3", ctx));
    expect(opened.result.route).toBe("notify");
    expect(opened.result.allowed).toEqual(["ignore", "respond"]);
    expect(opened.state).toBe(AWAITING);
    expect(stateOf(ctx).proposal).toEqual({ kind: "notify" });
  });

  test("an untriaged email is triaged on the way in; a filed one can be reopened", async () => {
    const { ctx, model } = scriptedDesk();
    await openById("m6", ctx);
    expect(model.calls.filter((c) => c.system === TRIAGE_SYSTEM)).toHaveLength(1);
    await run("ignore", ctx);
    const filed = expectToolOk<{ reopened: boolean; instructions: string }>(
      await openById("m1", ctx),
    );
    expect(filed.reopened).toBe(false);
    expect(filed.instructions).toMatch(/filed this one/);
    await run("ignore", ctx);
    const again = expectToolOk<{ reopened: boolean }>(await openById("m1", ctx));
    expect(again.reopened).toBe(true);
  });

  test("refuses while an email is open, and names the ids for a bad one", async () => {
    const { ctx } = scriptedDesk();
    await openById("m2", ctx);
    const refused = await run("open_email", { id: "m4" }, ctx);
    expect(isToolFailure(refused) && refused.error).toContain(`"${DRAFTING}"`);
    await run("ignore", ctx);
    expect(await openById("zz", ctx)).toMatchObject({ error: expect.stringContaining("m2, m3") });
  });

  test.each(INBOX.map((e) => e.id))(
    "%s: the thread and the brief fit one tool result",
    async (id) => {
      // Tool results are capped at 4000 chars, and this one carries a whole
      // thread plus the drafting brief with every memory prompt in it.
      const { ctx } = scriptedDesk();
      const result = await openById(id, ctx);
      expect(isToolFailure(result)).toBe(false);
      expect(JSON.stringify(result).length).toBeLessThan(4000);
    },
  );
});

// ─── 3. Drafting stages, never sends ─────────────────────────────────────────

describe("the drafting tools (their drafting model's tool list)", () => {
  const DRAFTERS = [
    ["draft_reply", { content: "Yes, inference stays inside your VPC." }],
    ["new_email", { recipients: ["priya@lumenlabs.dev"], content: "Can you take this one?" }],
    ["ask_question", { content: "Is the audit closed?" }],
    [
      "send_calendar_invite",
      {
        emails: ["sam.reyes@acme-partners.com"],
        title: "Lumen x Acme",
        startTime: "2026-03-18T13:00:00",
        endTime: "2026-03-18T13:30:00",
      },
    ],
    ["meeting_assistant", { request: "Tuesday or Wednesday afternoon next week" }],
  ] as const;

  test.each(DRAFTERS)("%s refuses when no email is open", async (name, args) => {
    const { ctx } = scriptedDesk();
    const refused = await run(name, args, ctx);
    expect(isToolFailure(refused) && refused.error).toContain(`"${AT_INBOX}"`);
    expect(stateOf(ctx).proposal).toBeNull();
    expect(stateOf(ctx).sent).toEqual([]);
  });

  test("draft_reply rewrites in the executive's tone and stages the result", async () => {
    const { ctx, model } = scriptedDesk();
    await openById("m2", ctx);
    const staged = expectDialogOk<{
      awaitingDecision: true;
      proposal: { body: string };
      allowed: string[];
      readBack: string;
    }>(await run("draft_reply", { content: "Yes — inference stays inside your VPC." }, ctx));
    expect(staged.state).toBe(AWAITING);
    expect(staged.result.awaitingDecision).toBe(true);
    expect(staged.result.allowed).toEqual(["accept", "edit", "ignore", "respond"]);
    expect(staged.result.readBack).toMatch(/Nothing has been sent/);
    // Their `rewrite` node ran, on the tone memory, over this draft.
    const rewrite = model.calls.find((c) => c.system === REWRITE_SYSTEM);
    expect(rewrite?.prompt).toContain(DEFAULT_MEMORY.rewriteInstructions);
    expect(rewrite?.prompt).toContain("inference stays inside your VPC");
    expect(staged.result.proposal.body).toBe(
      "(in Maya's voice) Yes — inference stays inside your VPC.",
    );
    // THE claim: staged is not sent.
    expect(stateOf(ctx).sent).toEqual([]);
    expect(stateOf(ctx).emails.find((e) => e.id === "m2")?.status).toBe("open");
  });

  test("a draft with a placeholder is refused before it reaches the rewriter", async () => {
    const { ctx, model } = scriptedDesk();
    await openById("m2", ctx);
    const refused = await run("draft_reply", { content: "Hi [name], yes it does." }, ctx);
    expect(isToolFailure(refused) && refused.error).toContain("ask_question");
    expect(model.calls.filter((c) => c.system === REWRITE_SYSTEM)).toHaveLength(0);
    expect(at(ctx)).toBe(DRAFTING);
  });

  test("ask_question stages a question that takes only ignore or respond", async () => {
    const { ctx } = scriptedDesk();
    await openById("m7", ctx);
    const staged = expectToolOk<{ allowed: string[] }>(
      await run("ask_question", { content: "Is the audit closed?" }, ctx),
    );
    expect(staged.allowed).toEqual(["ignore", "respond"]);
    expect(stateOf(ctx).proposal).toEqual({ kind: "question", content: "Is the audit closed?" });
  });

  test("send_calendar_invite validates the times, then stages", async () => {
    const { ctx } = scriptedDesk();
    await openById("m4", ctx);
    const invite = DRAFTERS[3][1];
    expect(
      await run("send_calendar_invite", { ...invite, endTime: "2026-03-18T12:00:00" }, ctx),
    ).toMatchObject({
      error: expect.stringContaining("ends before it starts"),
    });
    expect(at(ctx)).toBe(DRAFTING);
    expectDialogOk(await run("send_calendar_invite", invite, ctx));
    expect(stateOf(ctx).proposal).toMatchObject({ kind: "invite", title: "Lumen x Acme" });
    expect(stateOf(ctx).sent).toEqual([]);
  });

  test("meeting_assistant delegates the thread and stays in drafting", async () => {
    const { ctx, desk } = scriptedDesk();
    await openById("m4", ctx);
    const found = expectDialogOk<{ availability: string; lookups: number }>(
      await run("meeting_assistant", { request: "Tuesday or Wednesday afternoon" }, ctx),
    );
    expect(found.result.availability).toContain("Wednesday 1pm-3pm");
    expect(found.result.lookups).toBe(1);
    expect(found.state).toBe(DRAFTING);
    expect(desk.calls[0]?.subagent.name).toBe("meeting-assistant");
    expect(desk.calls[0]?.task).toContain("Time to catch up next week?");
    expect(stateOf(ctx).exchange.at(-1)).toMatch(/^Meeting assistant:/);
  });

  test("propose refuses a second proposal rather than replacing the first", () => {
    // Two drafting tools in one concurrent step both pass the gate; the second
    // one to write must be turned away naming what is already waiting.
    const state = seedAssistant();
    state.emails[1]!.status = "open";
    state.openId = "m2";
    expect(propose(state, { kind: "question", content: "A?" })).toMatchObject({
      awaitingDecision: true,
    });
    const second = propose(state, { kind: "question", content: "B?" });
    expect(isToolFailure(second) && second.error).toContain("A question for you");
    expect(state.proposal).toEqual({ kind: "question", content: "A?" });
  });
});

// ─── 4. The four answers (their HumanResponse) ───────────────────────────────

describe("accept / edit / ignore / respond", () => {
  const stageReply = async (ctx: ToolContext, id = "m2") => {
    await openById(id, ctx);
    await run("draft_reply", { content: "Yes, it stays in your VPC." }, ctx);
  };

  test("accept is the only thing that sends, and re-arms the inbox", async () => {
    const { ctx } = scriptedDesk();
    await stageReply(ctx);
    const sent = expectDialogOk<{ sent: string }>(await run("accept", ctx));
    expect(sent.result.sent).toContain("dana.whitfield@northwind.io");
    expect(sent.state).toBe(AT_INBOX);
    const state = stateOf(ctx);
    expect(state.sent).toEqual([expect.objectContaining({ emailId: "m2", kind: "reply" })]);
    expect(state.emails.find((e) => e.id === "m2")).toMatchObject({
      status: "closed",
      closedAs: "sent",
    });
    expect(state.openId).toBeNull();
    expect(state.proposal).toBeNull();
    // Their `save_email(…, "email")`.
    expect(state.triageExamples).toEqual([
      expect.objectContaining({ emailId: "m2", result: "email" }),
    ]);
    // The gate re-armed: a second accept meets `when`.
    expect(await run("accept", ctx)).toMatchObject({
      error: expect.stringContaining(`this conversation is at "${AT_INBOX}"`),
    });
  });

  test.each([
    ["accept", "m7", "ask_question", { content: "Audit closed?" }],
    ["edit", "m7", "ask_question", { content: "Audit closed?" }],
  ] as const)(
    "%s is refused for a question, which takes only ignore or respond",
    async (answer, id, tool, args) => {
      const { ctx } = scriptedDesk();
      await openById(id, ctx);
      await run(tool, args, ctx);
      const refused = await run(answer, { content: "x" }, ctx);
      expect(isToolFailure(refused) && refused.error).toMatch(/only ignore or respond/);
      // Refused BEFORE the transition: still waiting, nothing sent.
      expect(at(ctx)).toBe(AWAITING);
      expect(stateOf(ctx).sent).toEqual([]);
    },
  );

  test("accept is refused for a heads-up too", async () => {
    const { ctx } = scriptedDesk();
    await openById("m3", ctx);
    expect(await run("accept", ctx)).toMatchObject({
      error: expect.stringContaining("only ignore or respond"),
    });
  });

  test("edit sends the executive's version and learns from the difference", async () => {
    const { ctx, model } = scriptedDesk({
      chooser: ["tone"],
      update: {
        logic: "Maya signs off with just her name.",
        updatePrompt: true,
        newPrompt: "Sign off with 'Maya'.",
      },
    });
    await stageReply(ctx);
    const sent = expectDialogOk<{ sent: string; learned: string }>(
      await run("edit", { content: "Inside your VPC, yes. Pilot when you're ready.\nMaya" }, ctx),
    );
    expect(sent.state).toBe(AT_INBOX);
    expect(sent.result.learned).toContain("tone");
    const state = stateOf(ctx);
    expect(state.exchange).toContain("Sent: Inside your VPC, yes. Pilot when you're ready.\nMaya");
    // Their reflection: "A better response would have been", then the rewrite.
    const chooser = model.calls.find((c) => c.system === CHOOSE_MEMORY_SYSTEM);
    expect(chooser?.prompt).toContain("A better response would have been: Inside your VPC");
    expect(model.calls.filter((c) => c.system === UPDATE_MEMORY_SYSTEM)).toHaveLength(1);
    expect(state.memory.rewriteInstructions).toBe("Sign off with 'Maya'.");
    expect(state.reflections).toEqual([
      { memory: "rewriteInstructions", logic: "Maya signs off with just her name." },
    ]);
    // And the next draft's rewrite reads the NEW tone prompt.
    await stageReply(ctx, "m7");
    expect(model.calls.filter((c) => c.system === REWRITE_SYSTEM).at(-1)?.prompt).toContain(
      "Sign off with 'Maya'.",
    );
  });

  test("edit on an invite changes the fields given and sends", async () => {
    const { ctx } = scriptedDesk();
    await openById("m4", ctx);
    await run(
      "send_calendar_invite",
      {
        emails: ["sam.reyes@acme-partners.com"],
        title: "Lumen x Acme",
        startTime: "2026-03-18T13:00:00",
        endTime: "2026-03-18T13:30:00",
      },
      ctx,
    );
    expect(await run("edit", {}, ctx)).toMatchObject({
      error: expect.stringContaining("new title"),
    });
    const sent = expectToolOk<{ sent: string }>(
      await run("edit", { title: "Roadmap catch-up" }, ctx),
    );
    expect(sent.sent).toContain("Roadmap catch-up");
    expect(stateOf(ctx).emails.find((e) => e.id === "m4")?.closedAs).toBe("invited");
  });

  test("ignore drops what is staged, marks the thread read, and remembers a `no`", async () => {
    const { ctx } = scriptedDesk();
    await stageReply(ctx);
    const gone = expectDialogOk<{ ignored: string; dropped: string | null }>(
      await run("ignore", ctx),
    );
    expect(gone.result.dropped).toBe("Reply");
    expect(gone.state).toBe(AT_INBOX);
    expect(stateOf(ctx).emails.find((e) => e.id === "m2")?.closedAs).toBe("ignored");
    expect(stateOf(ctx).triageExamples).toEqual([expect.objectContaining({ result: "no" })]);
    expect(stateOf(ctx).sent).toEqual([]);
  });

  test("ignoring a heads-up files it as notified", async () => {
    const { ctx } = scriptedDesk();
    await openById("m3", ctx);
    await run("ignore", ctx);
    expect(stateOf(ctx).emails.find((e) => e.id === "m3")?.closedAs).toBe("notified");
  });

  test("respond hands a question's answer back and reflects on background only", async () => {
    const { ctx, model } = scriptedDesk({ chooser: ["tone", "background"] });
    await openById("m7", ctx);
    await run("ask_question", { content: "Is the audit closed?" }, ctx);
    const back = expectDialogOk<{ feedback: string; instructions: string }>(
      await run("respond", { feedback: "Yes, closed last Friday." }, ctx),
    );
    expect(back.state).toBe(DRAFTING);
    expect(back.result.feedback).toBe(
      `${EXECUTIVE.name} responded in this way: Yes, closed last Friday.`,
    );
    expect(stateOf(ctx).proposal).toBeNull();
    expect(stateOf(ctx).exchange.at(-1)).toContain("responded in this way");
    // Their `prompt_types=["background"]`: the chooser is offered one type, and a
    // chooser that names `tone` anyway rewrites nothing but background.
    const chooser = model.calls.find((c) => c.system === CHOOSE_MEMORY_SYSTEM);
    expect(chooser?.prompt).toContain("`background`");
    expect(chooser?.prompt).not.toContain("`tone`");
    expect(model.calls.filter((c) => c.system === UPDATE_MEMORY_SYSTEM)).toHaveLength(1);
    // The email is still open, so drafting can carry on — and then send.
    await run("draft_reply", { content: "Go ahead and quote 128%." }, ctx);
    expectDialogOk(await run("accept", ctx));
    expect(stateOf(ctx).sent).toHaveLength(1);
  });

  test("respond on a draft is their 'interrupted' feedback, and the draft comes back", async () => {
    const { ctx } = scriptedDesk();
    await stageReply(ctx);
    const back = expectDialogOk<{ feedback: string }>(
      await run("respond", { feedback: "Shorter." }, ctx),
    );
    expect(back.result.feedback).toBe(
      `Error, ${EXECUTIVE.name} interrupted and gave this feedback: Shorter.`,
    );
    expect(back.state).toBe(DRAFTING);
    expect(stateOf(ctx).sent).toEqual([]);
    expect(stateOf(ctx).emails.find((e) => e.id === "m2")?.status).toBe("open");
  });

  test("respond on a heads-up turns instructions into a drafting turn", async () => {
    const { ctx } = scriptedDesk();
    await openById("m3", ctx);
    const back = expectDialogOk<{ feedback: string }>(
      await run("respond", { feedback: "Tell Goodwin I'll sign Friday." }, ctx),
    );
    expect(back.result.feedback).toContain("gave these instructions");
    expect(back.state).toBe(DRAFTING);
  });

  test("two contexts never share an inbox, a memory or a gate", async () => {
    const first = scriptedDesk();
    const second = scriptedDesk();
    await stageReply(first.ctx);
    await run("accept", first.ctx);
    expect(stateOf(second.ctx).sent).toEqual([]);
    expect(at(second.ctx)).toBe(AT_INBOX);
    expect(stateOf(first.ctx).sent).toHaveLength(1);
  });
});

// ─── 5. Reflection and the calendar, directly ────────────────────────────────

describe("reflect (their multi_reflection_graph)", () => {
  const input = { memory: { ...DEFAULT_MEMORY }, trajectory: "t", feedback: "f" };

  test("rewrites each chosen prompt in parallel and skips a declined one", async () => {
    let updates = 0;
    const model = stubGenerate({
      [CHOOSE_MEMORY_SYSTEM]: { object: { memoryTypesToUpdate: ["tone", "calendar"] } },
      [UPDATE_MEMORY_SYSTEM]: (call) => {
        updates += 1;
        const calendar = call.prompt.includes(DEFAULT_MEMORY.schedulePreferences);
        return {
          object: {
            logic: calendar ? "45 minutes" : "",
            updatePrompt: calendar,
            newPrompt: calendar ? "Meetings are 45 minutes." : "",
          },
        };
      },
    });
    const out = await reflect(model.generate, { ...input, promptTypes: ["tone", "calendar"] });
    expect(updates).toBe(2);
    expect(out).toEqual([
      {
        type: "calendar",
        memory: "schedulePreferences",
        logic: "45 minutes",
        newPrompt: "Meetings are 45 minutes.",
      },
    ]);
  });

  test("a chooser that names nothing costs no second call", async () => {
    const model = stubGenerate({ [CHOOSE_MEMORY_SYSTEM]: { object: { memoryTypesToUpdate: [] } } });
    expect(await reflect(model.generate, { ...input, promptTypes: ["tone"] })).toEqual([]);
    expect(model.calls).toHaveLength(1);
  });
});

describe("the meeting assistant's calendar tool", () => {
  test("answers each day's events with its weekday", async () => {
    const days = await calendarTool.execute(
      { days: ["2026-03-17", "2026-03-21"] },
      createToolContext(),
    );
    expect(days).toMatchObject({
      timezone: "PST",
      days: [
        {
          date: "2026-03-17",
          weekday: "Tuesday",
          events: ["13:00-14:00 Customer call — Fable Health", "15:00-17:00 Board meeting"],
        },
        { date: "2026-03-21", weekday: "Saturday", events: [] },
      ],
    });
    expect(weekdayOf("2026-03-09")).toBe("Monday");
  });
});

// ─── 6. The projection, and a caller who hangs up ────────────────────────────

describe("assistantView projection", () => {
  test("an untouched call projects the seeded inbox at rest", () => {
    const view = assistantProjection();
    expect(view.phase).toBe("inbox");
    expect(view.emails).toHaveLength(INBOX.length);
    expect(view.emails.every((e) => e.status === "untriaged")).toBe(true);
    expect(view.proposal).toBeNull();
    expect(view.memory).toEqual(DEFAULT_MEMORY);
  });

  test("renders the staged draft as the prose the assistant just read", async () => {
    const { ctx } = scriptedDesk();
    await openById("m2", ctx);
    await run("draft_reply", { content: "Yes." }, ctx);
    const view = assistantView(stateOf(ctx));
    expect(view.phase).toBe("awaitingDecision");
    expect(view.proposal).toMatchObject({
      kind: "reply",
      title: "Reply",
      body: "(in Maya's voice) Yes.",
    });
    expect(view.open?.id).toBe("m2");
  });
});

describe("an executive who hangs up", () => {
  const CALLER_GONE = { type: "session.timed-out", meta: { id: "evt_1", at: 0 } } as const;

  test("ends the review with a draft still waiting, and accept can never run", async () => {
    const { ctx } = scriptedDesk();
    await openById("m2", ctx);
    await run("draft_reply", { content: "Yes." }, ctx);
    const gone = reviewFlow.receive(ctx, CALLER_GONE);
    expect(gone.state).toBe("abandoned");
    expect(gone.done).toBe(true);
    const refused = await run("accept", ctx);
    expect(isToolFailure(refused) && refused.error).toContain('"abandoned"');
    // The proposal is still there — the state is final, so nothing reads it.
    expect(stateOf(ctx).proposal).not.toBeNull();
    expect(stateOf(ctx).sent).toEqual([]);
  });
});
