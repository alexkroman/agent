/** The def a DEPLOYED agent runs: authored, plus `tools/` and `system-prompt.md`. */
import deployedDef from "virtual:aai/agent";
import { DEFAULT_CLIENT_DELIVERY_ATTEMPTS } from "@alexkroman1/aai/step";
import {
  createRunSnapshot,
  createToolContext,
  createWorkflowContext,
  expectDeployable,
  expectPromptBuiltinsDeclared,
  runTool,
} from "@alexkroman1/aai/testing";
import {
  installStubClientInbox,
  installStubGateway,
  installStubSpeech,
  installStubStepFetch,
  installStubWorkflows,
} from "@alexkroman1/aai/testing/vitest";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import agentDef from "./agent.ts";
import {
  homeTimeZone,
  MAX_REMINDER_MS,
  remind,
  reminderDueAt,
  research,
  spokenDue,
} from "./shared.ts";
import cancelReminders from "./tools/cancel_reminders.ts";
import deepResearch from "./tools/deep_research.ts";
import remindMe from "./tools/remind_me.ts";
import stop from "./tools/stop.ts";
import { remindFlow } from "./workflows/remind.ts";
import { readyText, researchWorkflow, withSources } from "./workflows/research.ts";
import { BRIEF_SYSTEM } from "./workflows/research-prompts.ts";
import { TEXT_STEP, textOwner } from "./workflows/text.ts";

// The home's clock, named, so no case depends on the zone the test machine runs in.
const ZONE = "America/Los_Angeles";
const env = { TIME_ZONE: ZONE };
/** An instant given as a wall-clock time in ZONE (PDT, UTC-7, until November 1 2026). */
const pdt = (month: number, day: number, h: number, m = 0) =>
  Date.UTC(2026, month - 1, day, h + 7, m);
/** Monday 2026-09-28, 2 PM at home. */
const NOW = new Date(pdt(9, 28, 14));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the agent", () => {
  test("is deployable with its prompt, its builtins and both workflows", () => {
    const config = expectDeployable(deployedDef);
    expect(config.name).toBe("Home Assistant");
    expect(Object.keys(deployedDef.workflows ?? {}).sort()).toEqual(["remind", "research"]);
    // Every builtin the prompt names is one the agent declared.
    expect(() => expectPromptBuiltinsDeclared(deployedDef)).not.toThrow();
  });

  test("the builtins are pinned, with think kept", () => {
    // Order-sensitive on purpose: a builtin added or dropped should be a diff here.
    expect(agentDef.builtinTools).toEqual([
      "think",
      "open_meteo",
      "web_search",
      "calculate",
      "visit_webpage",
      "text_me",
    ]);
  });

  test("the custom tools are exactly tools/, and none shadows a builtin", () => {
    const tools = Object.keys(deployedDef.tools ?? {}).sort();
    expect(tools).toEqual(["cancel_reminders", "deep_research", "remind_me", "stop"]);
    for (const name of tools) expect(agentDef.builtinTools).not.toContain(name);
  });
});

describe("homeTimeZone", () => {
  test("is TIME_ZONE when it names a zone, else this machine's", () => {
    const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(homeTimeZone({ TIME_ZONE: "America/Chicago" })).toBe("America/Chicago");
    expect(homeTimeZone({ TIME_ZONE: " Europe/Paris " })).toBe("Europe/Paris");
    expect(homeTimeZone({})).toBe(machine);
    expect(homeTimeZone({ TIME_ZONE: "Not/AZone" })).toBe(machine);
  });
});

describe("reminderDueAt", () => {
  test("a duration counts from now", () => {
    expect(reminderDueAt(NOW, { inSeconds: 90 }, ZONE)).toBe(NOW.getTime() + 90_000);
  });

  test("a clock time is today when it is still ahead, tomorrow when it has passed", () => {
    expect(reminderDueAt(NOW, { at: "17:00" }, ZONE)).toBe(pdt(9, 28, 17));
    expect(reminderDueAt(NOW, { at: "09:30" }, ZONE)).toBe(pdt(9, 29, 9, 30));
    expect(reminderDueAt(NOW, { at: "14:00" }, ZONE)).toBe(pdt(9, 29, 14));
  });

  test("the clock is the HOME's, not the process's", () => {
    // 2 PM in Los Angeles is 5 PM in New York: "at 18:00" there is an hour off, today.
    expect(reminderDueAt(NOW, { at: "18:00" }, "America/New_York")).toBe(NOW.getTime() + 3_600_000);
    expect(reminderDueAt(NOW, { at: "22:00" }, "UTC")).toBe(Date.UTC(2026, 8, 28, 22));
  });

  test("nine o'clock across a daylight-saving change is still nine on the clock", () => {
    // Saturday Oct 31, 8 PM PDT; clocks fall back at 2 AM, so 9 AM Sunday is UTC-8.
    const night = new Date(pdt(10, 31, 20));
    expect(reminderDueAt(night, { at: "09:00" }, ZONE)).toBe(Date.UTC(2026, 10, 1, 17));
  });

  test("nothing usable is undefined", () => {
    // "9:30" too: isClockTime wants it zero-padded, as the tool's clockTime field says.
    for (const at of [undefined, "", "5pm", "9:30", "24:00", "12:60"]) {
      expect.soft(reminderDueAt(NOW, { at }, ZONE), String(at)).toBeUndefined();
    }
  });
});

describe("spokenDue", () => {
  test("says today's time bare, and names tomorrow or the weekday", () => {
    expect(spokenDue(NOW, pdt(9, 28, 17), ZONE)).toBe("5 PM");
    expect(spokenDue(NOW, pdt(9, 28, 17, 30), ZONE)).toBe("5:30 PM");
    expect(spokenDue(NOW, pdt(9, 29, 7), ZONE)).toBe("tomorrow at 7 AM");
    expect(spokenDue(NOW, pdt(9, 30, 7, 5), ZONE)).toBe("Wednesday at 7:05 AM");
    expect(spokenDue(NOW, pdt(10, 4, 9), ZONE)).toBe("Sunday at 9 AM");
  });

  test("a week out is today's weekday again, so it says the date too", () => {
    expect(spokenDue(NOW, pdt(10, 5, 9), ZONE)).toBe("Monday, October 5 at 9 AM");
  });

  test("midnight and noon", () => {
    expect(spokenDue(NOW, pdt(9, 29, 0), ZONE)).toBe("tomorrow at 12 AM");
    expect(spokenDue(NOW, pdt(9, 29, 12), ZONE)).toBe("tomorrow at 12 PM");
  });
});

describe("remind_me", () => {
  test("starts a run for this speaker, keyed by its client id so cancel can find it", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const workflows = installStubWorkflows({ runId: "wrun_1" });
    const ctx = createToolContext({ clientId: "kitchen", env, workflows });
    const result = await runTool(remindMe, { text: "call the plumber", at: "17:00" }, ctx);
    expect(result).toEqual({ scheduled: true, text: "call the plumber", due: "5 PM" });
    expect(workflows.start).toHaveBeenCalledWith(
      remind,
      { clientId: "kitchen", text: "call the plumber", dueAt: pdt(9, 28, 17) },
      { key: "kitchen", label: "call the plumber · due 5 PM" },
    );
  });

  test("a session with no client id has no inbox to say it on, so it cannot take one", async () => {
    const workflows = installStubWorkflows();
    const ctx = createToolContext({ env, workflows });
    const result = await runTool(remindMe, { text: "x", in_seconds: 60 }, ctx);
    expect(result).toHaveProperty("error");
    expect(workflows.start).not.toHaveBeenCalled();
  });

  test("no usable time, or more than a week away, is refused", async () => {
    const workflows = installStubWorkflows();
    const ctx = createToolContext({ clientId: "k", env, workflows });
    expect(await runTool(remindMe, { text: "x", at: "five" }, ctx)).toHaveProperty("error");
    const tooFar = MAX_REMINDER_MS / 1000 + 1;
    expect(await runTool(remindMe, { text: "x", in_seconds: tooFar }, ctx)).toHaveProperty("error");
    expect(workflows.start).not.toHaveBeenCalled();
  });
});

describe("cancel_reminders", () => {
  test("cancels this speaker's reminders that have not fired, and counts them", async () => {
    const workflows = installStubWorkflows({
      runs: [
        createRunSnapshot({ runId: "a", workflow: "remind", status: "running" }),
        createRunSnapshot({ runId: "b", workflow: "remind", status: "pending" }),
        createRunSnapshot({ runId: "c", workflow: "remind", status: "completed", output: {} }),
      ],
    });
    const ctx = createToolContext({ clientId: "kitchen", workflows });
    expect(await runTool(cancelReminders, {}, ctx)).toEqual({ cancelled: 2 });
    expect(workflows.cancelAll).toHaveBeenCalledWith(remind, "kitchen");
  });

  test("with no client id there is nothing of theirs to cancel", async () => {
    const workflows = installStubWorkflows();
    expect(await runTool(cancelReminders, {}, createToolContext({ workflows }))).toEqual({
      cancelled: 0,
    });
    expect(workflows.cancelAll).not.toHaveBeenCalled();
  });
});

describe("stop", () => {
  test("tells the client to stop, which is what silences it", async () => {
    const ctx = createToolContext();
    expect(await runTool(stop, {}, ctx)).toEqual({ stopped: true });
    expect(ctx.sent).toEqual([{ event: "stop", data: {} }]);
  });
});

describe("the remind workflow", () => {
  test("sleeps until it is due, then delivers in one retried step", async () => {
    const dueAt = NOW.getTime() + 60_000;
    const ctx = createWorkflowContext({ runSteps: false, now: NOW.getTime() });
    await remindFlow({ clientId: "kitchen", text: "flip the laundry", dueAt }, ctx);
    // The wait is measured from the journaled clock, never the process's.
    expect(ctx.slept).toEqual([{ label: "due", until: 60_000 }]);
    expect(ctx.steps).toEqual([{ name: "deliver", maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS }]);
  });

  test("deliver says the reminder on the speaker under the run id", async () => {
    const speech = installStubSpeech({ pcmBytes: 3200 });
    const inbox = installStubClientInbox();
    const ctx = createWorkflowContext({ runId: "wrun_7" });
    await remindFlow({ clientId: "kitchen", text: "flip the laundry", dueAt: 0 }, ctx);
    expect(speech.calls).toMatchObject([{ text: "Reminder: flip the laundry" }]);
    const [{ clientId, notice }] = inbox.calls as [(typeof inbox.calls)[number]];
    expect(clientId).toBe("kitchen");
    expect(notice).toMatchObject({
      id: "wrun_7",
      event: "reminder",
      // `said` is what the page shows as the speaker's turn: the words it spoke.
      data: { text: "flip the laundry", said: "Reminder: flip the laundry" },
    });
    expect(notice.audio?.length).toBe(3200);
  });

  test("a speaker that is busy fails the attempt as retryable, so the step redelivers", async () => {
    installStubSpeech();
    installStubClientInbox({ answer: "busy" });
    const ctx = createWorkflowContext({ runId: "wrun_8" });
    await expect(
      remindFlow({ clientId: "kitchen", text: "x", dueAt: 0 }, ctx),
    ).rejects.toMatchObject({ name: "ClientUnreachableError", reason: "busy" });
  });
});

describe("the run is DURABLE", () => {
  const INPUT = { clientId: "kitchen", text: "flip the laundry", dueAt: Date.now() + 60_000 };

  test("parks on its due time without saying anything, then says it once woken", async () => {
    installStubSpeech();
    const inbox = installStubClientInbox();
    const run = await runWorkflow(remind, INPUT, { name: "remind" });

    // Parked, not blocking: nothing delivered, the wake time journaled.
    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeGreaterThanOrEqual(INPUT.dueAt);
    expect(run.wakeAt).toBeLessThan(INPUT.dueAt + 5000);
    expect(inbox.calls).toEqual([]);

    await run.advanceSleep();
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ delivered: true });
    expect(inbox.calls).toHaveLength(1);
  });

  test("a worker dying mid-delivery resumes the delivery rather than the wait", async () => {
    installStubSpeech();
    const inbox = installStubClientInbox();
    const run = await runWorkflow(remind, INPUT, { name: "remind", crashAt: "deliver" });
    await run.advanceSleep();
    expect(run.crashed).toBe(true);

    await run.restart();
    expect(run.status).toBe("completed");
    // Said once, under the run id, so a repeat after a lost ack is one the client drops.
    expect(inbox.calls.map((call) => call.notice.id)).toEqual([run.runId]);
  });
});

const a = { title: "Heat pumps, explained", url: "https://example.com/a" };
const b = { title: "Cold-climate models", url: "https://example.com/b" };

describe("withSources", () => {
  test("titles the text and appends the cited urls", () => {
    expect(withSources("heat pumps", " They work [2]. ", [a, b])).toBe(
      "Research: heat pumps\n\nThey work [2].\n\nSources:\n[2] https://example.com/b",
    );
  });

  test("sources that don't fit one text are dropped whole, last first", () => {
    const body = "They work [1][2].";
    const both = withSources("t", body, [a, b]);
    const oneLess = withSources("t", body, [a, b], both.length - 1);
    expect(oneLess).toBe(`Research: t\n\n${body}\n\nSources:\n[1] https://example.com/a`);
    expect(withSources("t", body, [a, b], 10)).toBe(`Research: t\n\n${body}`);
  });

  test("a report that cites nothing gets no sources list", () => {
    expect(withSources("x", "Inconclusive.", [a])).toBe("Research: x\n\nInconclusive.");
  });
});

describe("deep_research", () => {
  test("starts a run that only says the results on this session's speaker", async () => {
    const workflows = installStubWorkflows({ runId: "wrun_1" });
    const ctx = createToolContext({ clientId: "kitchen", clientPhone: "+15555550123", workflows });
    const result = await runTool(deepResearch, { topic: "heat pumps for an old house" }, ctx);
    expect(result).toEqual({ started: true, delivery: "said on the speaker" });
    expect(workflows.start).toHaveBeenCalledWith(
      research,
      {
        topic: "heat pumps for an old house",
        clientId: "kitchen",
        phone: "+15555550123",
        text: false,
      },
      { key: "kitchen", label: "heat pumps for an old house" },
    );
  });

  test("texts the report too when they asked for a text", async () => {
    const workflows = installStubWorkflows({ runId: "wrun_1" });
    const ctx = createToolContext({ clientId: "kitchen", workflows });
    expect(await runTool(deepResearch, { topic: "heat pumps", text: true }, ctx)).toEqual({
      started: true,
      delivery: "said on the speaker, and texted",
    });
  });

  test("with no speaker it texts only when asked, and otherwise starts nothing", async () => {
    const workflows = installStubWorkflows();
    const ctx = createToolContext({ workflows });
    expect(await runTool(deepResearch, { topic: "heat pumps", text: true }, ctx)).toEqual({
      started: true,
      delivery: "texted",
    });
    vi.mocked(workflows.start).mockClear();
    const refused = await runTool(deepResearch, { topic: "heat pumps" }, ctx);
    expect(JSON.stringify(refused)).toContain("Ask whether to text them");
    expect(workflows.start).not.toHaveBeenCalled();
  });
});

const brief = { brief: "Heat pumps for an old house.", criteria: ["cost"] };
/** The SDK's stages, answered by name so the body reaches the speaker's own steps. */
const stages = {
  writeBrief: brief,
  planAngles: ["cost"],
  investigate: { angle: "cost", findings: "Rebates help [1].", sources: [a] },
  findGaps: [],
  writeReport: { report: "Rebates help [1].", summary: "Rebates make them affordable." },
};

describe("the research workflow", () => {
  const input = { topic: "heat pumps", clientId: "kitchen" };

  test("says the summary on the speaker, and texts only when asked", async () => {
    const ctx = createWorkflowContext({ runSteps: false, results: stages });
    expect(await researchWorkflow.run(input, ctx)).toEqual({
      topic: "heat pumps",
      summary: "Rebates make them affordable.",
      sources: 1,
      texted: { sent: false },
      announced: true,
    });
    expect(ctx.steps.slice(-1)).toEqual([
      { name: "announce", maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS },
    ]);
    expect(ctx.steps.map((s) => s.name)).not.toContain("text");
  });

  test("a text they asked for is its own few-attempt step, before the announcement", async () => {
    const ctx = createWorkflowContext({
      runSteps: false,
      results: { ...stages, text: { sent: true } },
    });
    const out = await researchWorkflow.run({ ...input, text: true }, ctx);
    expect(out).toMatchObject({ texted: { sent: true } });
    expect(ctx.steps.slice(-2)).toEqual([
      { name: "text", maxAttempts: TEXT_STEP.maxAttempts },
      { name: "announce", maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS },
    ]);
  });

  /** The engine's failure hook: sayFailureOnClient's `{ run, maxAttempts }`. */
  function failureHook() {
    const hook = researchWorkflow.onFailure;
    if (typeof hook !== "object") throw new Error("onFailure is not the engine's handler");
    return hook;
  }

  test("a failure fails the run, and the ENGINE's hook says it on the speaker", async () => {
    // No angles planned: the fan-out has nothing to map, and the pass throws.
    const ctx = createWorkflowContext({ runSteps: false, results: { writeBrief: brief } });
    await expect(researchWorkflow.run(input, ctx)).rejects.toThrow();
    expect(ctx.steps.map((s) => s.name)).not.toContain("announce");

    installStubSpeech();
    const inbox = installStubClientInbox();
    const hook = failureHook();
    expect(hook.maxAttempts).toBe(DEFAULT_CLIENT_DELIVERY_ATTEMPTS);
    await hook.run(new Error("The search service is down."), {
      runId: "wrun_4",
      workflow: "research",
      input,
    });
    expect(inbox.calls).toMatchObject([
      {
        clientId: "kitchen",
        notice: {
          id: "wrun_4:failed",
          event: "research",
          data: {
            topic: "heat pumps",
            failed: true,
            said: "Sorry, the research on heat pumps didn't finish. The search service is down.",
          },
        },
      },
    ]);
  });

  test("with no speaker to say it on, a failure says nothing", async () => {
    const inbox = installStubClientInbox();
    await failureHook().run(new Error("down"), {
      runId: "wrun_5",
      workflow: "research",
      input: { topic: "heat pumps" },
    });
    expect(inbox.calls).toEqual([]);
  });

  test("the brief is written with the speaker's prompt", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    const gateway = installStubGateway(JSON.stringify(brief));
    const { writeBrief: _, ...rest } = stages;
    const ctx = createWorkflowContext({ results: { ...rest, announce: undefined } });
    await researchWorkflow.run(input, ctx);
    expect(gateway[0]?.system).toContain(BRIEF_SYSTEM);
  });

  test("the announcement says the summary on the speaker under the run id", async () => {
    installStubSpeech({ pcmBytes: 3200 });
    const inbox = installStubClientInbox();
    const ctx = createWorkflowContext({ runId: "wrun_9", results: stages });
    await researchWorkflow.run(input, ctx);
    expect(inbox.calls).toMatchObject([
      {
        clientId: "kitchen",
        notice: {
          id: "wrun_9",
          event: "research",
          data: {
            topic: "heat pumps",
            said: "Your research on heat pumps is ready. Rebates make them affordable.",
          },
        },
      },
    ]);
  });

  test("and says whether the report was texted", () => {
    expect(readyText("heat pumps", "They work.", { sent: true })).toBe(
      "Your research on heat pumps is ready. They work. I've texted you the full report.",
    );
    expect(readyText("heat pumps", "They work.", { sent: false, why: "no credit" })).toBe(
      "Your research on heat pumps is ready. They work. I couldn't text you the full report: no credit",
    );
  });
});

describe("textOwner", () => {
  function textbelt() {
    vi.stubEnv("TEXTBELT_KEY", "test-key");
    vi.stubEnv("SMS_TO_PHONE", "+15555550100");
    vi.stubEnv("SMS_ALLOWED_PHONES", "+15555550111");
    const fetched = installStubStepFetch(() => ({ body: { success: true, textId: 1 } }));
    return () => JSON.parse(String(fetched.calls[0]?.body)) as { phone: string; message: string };
  }

  test("texts an allowlisted number the client reported", async () => {
    const sent = textbelt();
    expect(await textOwner("+15555550111", "The report.")).toEqual({ sent: true });
    expect(sent()).toMatchObject({ phone: "+15555550111", message: "The report." });
  });

  test("a number the client made up is ignored: the owner gets it", async () => {
    const sent = textbelt();
    await textOwner("+15555550999", "The report.");
    expect(sent().phone).toBe("+15555550100");
  });

  test("with no number at all it texts no one", async () => {
    vi.stubEnv("TEXTBELT_KEY", "k");
    vi.stubEnv("SMS_TO_PHONE", "");
    const fetched = installStubStepFetch(() => ({ body: { success: true } }));
    expect(await textOwner(undefined, "r")).toEqual({ sent: false });
    expect(fetched.calls).toEqual([]);
  });

  test("links are taken out before Textbelt sees the report", async () => {
    const sent = textbelt();
    await textOwner(
      "+15555550111",
      "It works [1].\n\nSources:\n[1] https://example.com/heat-pumps",
    );
    expect(sent().message).toBe("It works [1].");
  });

  test("a recipient with no TEXTBELT_KEY fails the step for good, naming the key", async () => {
    vi.stubEnv("TEXTBELT_KEY", "");
    vi.stubEnv("SMS_TO_PHONE", "+15555550100");
    await expect(textOwner(undefined, "The report.")).rejects.toMatchObject({
      name: "FatalError",
      message: expect.stringContaining("TEXTBELT_KEY"),
    });
  });
});
