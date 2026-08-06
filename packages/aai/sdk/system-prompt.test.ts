// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeConfig } from "../host/_test-utils.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./types.ts";

describe("buildSystemPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("starts with DEFAULT_SYSTEM_PROMPT when no custom instructions", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
  });

  test("does not include agent-specific instructions section for default instructions", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("Agent-Specific Instructions:");
  });

  test("appends custom agent instructions", () => {
    const custom = "You are a pirate. Always speak like one.";
    const result = buildSystemPrompt(makeConfig({ systemPrompt: custom }), { hasTools: false });
    expect(result).toContain("Agent-Specific Instructions:");
    expect(result).toContain(custom);
  });

  test("includes tool preamble when hasTools is true", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("Before the FIRST tool call of a turn, say a brief natural phrase");
  });

  test("omits tool preamble when hasTools is false", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain(
      "Before the FIRST tool call of a turn, say a brief natural phrase",
    );
  });

  // Measured against tau2-bench retail: 42/815 replies stacked two or more
  // preambles and 12 stacked three or more, because the old wording ("ALWAYS
  // say a brief natural phrase BEFORE the tool call") scopes per CALL and
  // `maxSteps` allows ten of them in one turn. The caller then hears a
  // play-by-play of the tool loop. These pin the scoping, not the phrasing.
  test("scopes the tool preamble to once per TURN, not once per tool call", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("ONCE PER TURN, not once per tool call");
    expect(result).toContain("stay silent between them");
  });

  test("tells the model a not-found lookup may be a mis-hearing", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("treat a MIS-HEARING as the most likely cause");
    // The re-ask must vary: repeating the request replays the same audio and
    // yields the same mis-transcription.
    expect(result).toContain("ask for something DIFFERENT");
  });

  test("appends voice rules when voice is true", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: true });
    expect(result).toContain("CRITICAL OUTPUT RULES");
    expect(result).toContain("NEVER use markdown");
  });

  test("voice rules tell the agent not to read spelled input back letter by letter", () => {
    // Verbose letter-by-letter readbacks make replies long and invite the
    // caller to interrupt mid-sentence (see tau2 turn-taking analysis).
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: true });
    expect(result).toContain("do NOT read the whole thing back letter by letter");
  });

  test("voice rules forbid reading long tool results out item by item", () => {
    // 30% of all synthesized agent audio in the tau2 run was discarded by
    // barge-in — the caller interrupts partway through an enumerated list and
    // never hears the rest.
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: true });
    expect(result).toContain("Do NOT read out long lists");
  });

  test("tool preamble forbids claiming an action without a successful tool result", () => {
    // The dominant failure across all three voice benchmarks: the agent says
    // "your window seat is reserved" having never called assign_seat, so the
    // final DB has seat=null. EVA scored faithfulness 0.075 on this alone.
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain("NEVER tell the caller an action is done");
    expect(result).toContain("Carrying something over");
  });

  test("tool preamble tells the agent to write spoken identifiers in written form", () => {
    // Spoken "K dash 2" reached add_to_cart as "K-2" (expected "K2"), and a
    // spelled confirmation code "Z K 3 F F W" arrived as "ZEDK3FFW" — the
    // single most common tool error in tau2 was "User not found".
    const result = buildSystemPrompt(makeConfig(), { hasTools: true });
    expect(result).toContain('"K dash 2" is K2');
    expect(result).toContain("ZK3FFW, never ZEDK3FFW");
    expect(result).toContain("ordinary title case");
  });

  test("action and identifier rules are tool-gated", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: true });
    expect(result).not.toContain("NEVER tell the caller an action is done");
    expect(result).not.toContain('"K dash 2" is K2');
  });

  test("omits voice rules when voice is false", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, voice: false });
    expect(result).not.toContain("CRITICAL OUTPUT RULES");
  });

  test("omits voice rules when voice is undefined", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).not.toContain("CRITICAL OUTPUT RULES");
  });

  test("includes correctly formatted date string", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("Today's date is Wednesday, January 15, 2025.");
  });

  test("date format uses en-US locale with weekday, month, day, and year", () => {
    // Advance to a different date to verify format consistency
    vi.setSystemTime(new Date("2025-12-31T12:00:00Z"));
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toContain("Today's date is Wednesday, December 31, 2025.");
  });

  test("voice + hasTools includes both voice rules and tool preamble", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: true, voice: true });
    expect(result).toContain("CRITICAL OUTPUT RULES");
    expect(result).toContain("Before the FIRST tool call of a turn, say a brief natural phrase");
  });

  test("custom instructions + voice + tools includes all sections", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Be concise." }), {
      hasTools: true,
      voice: true,
    });
    expect(result).toContain("Agent-Specific Instructions:");
    expect(result).toContain("Be concise.");
    expect(result).toContain("CRITICAL OUTPUT RULES");
    expect(result).toContain("Before the FIRST tool call of a turn, say a brief natural phrase");
  });

  test("sections appear in correct order", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      voice: true,
    });
    const dateIdx = result.indexOf("Today's date is");
    const instructionsIdx = result.indexOf("Agent-Specific Instructions:");
    const toolIdx = result.indexOf("Before the FIRST tool call of a turn");
    const voiceIdx = result.indexOf("CRITICAL OUTPUT RULES");

    expect(dateIdx).toBeGreaterThan(0);
    expect(instructionsIdx).toBeGreaterThan(dateIdx);
    expect(toolIdx).toBeGreaterThan(instructionsIdx);
    expect(voiceIdx).toBeGreaterThan(toolIdx);
  });

  test("empty custom instructions treated same as default", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "" }), { hasTools: false });
    expect(result).not.toContain("Agent-Specific Instructions:");
  });

  test("toolGuidance: [] omits the Built-in Tool Usage section", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false, toolGuidance: [] });
    expect(result).not.toContain("Built-in Tool Usage:");
  });

  test("toolGuidance lines are joined with newlines under one header", () => {
    const result = buildSystemPrompt(makeConfig(), {
      hasTools: false,
      toolGuidance: ["- Use think before answering.", "- Use recall to look things up."],
    });
    expect(result).toContain(
      "\n\nBuilt-in Tool Usage:\n- Use think before answering.\n- Use recall to look things up.",
    );
  });

  // Exact-equality assertions: the prompt text is behavior (it steers the
  // LLM), so pin every assembled byte rather than spot-checking fragments.
  test("minimal prompt is exactly the default plus the date", () => {
    const result = buildSystemPrompt(makeConfig(), { hasTools: false });
    expect(result).toBe(`${DEFAULT_SYSTEM_PROMPT}\n\nToday's date is Wednesday, January 15, 2025.`);
  });

  test("full prompt assembles every section verbatim", () => {
    const result = buildSystemPrompt(makeConfig({ systemPrompt: "Custom rules." }), {
      hasTools: true,
      voice: true,
      toolGuidance: ["- Guidance line."],
    });
    const toolPreamble =
      "\n\nBefore the FIRST tool call of a turn, say a brief natural phrase " +
      '(e.g. "Let me look that up" or "One moment while I check"). ' +
      "This fills silence while the tool executes. Keep it to one short sentence.\n" +
      "\nSay it ONCE PER TURN, not once per tool call. If you need several tools to answer, stay " +
      "silent between them and speak again when you have the answer. Narrating each step " +
      '("I will check the next order. I will keep checking your orders.") tells the caller nothing ' +
      "they need and makes a short wait sound like a long one.\n" +
      "\nThat opening phrase is ONLY for a turn that begins with a tool call and has nothing else to " +
      "say yet. If you already know something the caller is waiting on, lead with THAT instead — " +
      '"One moment." in front of an answer you already have just delays it.\n' +
      "\nOtherwise, report RESULTS, never intentions: do not announce what you are about to do — no " +
      '"I will look up …", "I will check …", "Let me pull up …". The caller cannot act on a plan, ' +
      "only on an answer, and each announcement is another sentence they can interrupt.\n" +
      'Wrong: "Thanks. I will look up your account now. I found your account. I will check that ' +
      'order now. Your order is delivered, and I found both items. I will check the options."\n' +
      'Right: "One moment." … then, once the calls are done: "Your order is delivered. Both items ' +
      'can be exchanged."\n' +
      "\nNEVER tell the caller an action is done unless a tool call returned a successful result for " +
      "it. Announcing an action is not performing it: if you say you are looking something up, " +
      "booking, changing, moving, or cancelling it, you MUST make the matching tool call in that same " +
      "turn. If you did not call the tool, or it returned an error, say what you still need — do not " +
      "describe the action as complete. Never state a confirmation number, price, total, seat, or " +
      "other detail that did not come from a tool result; if you need one, call the tool that returns " +
      "it. Carrying something over (a seat, a bag allowance, a preference) is itself an action: it " +
      "needs its own tool call, and does not happen because a related call succeeded.\n" +
      "\nWhen the caller speaks an identifier — an order or confirmation number, a product code, an " +
      "email — write it in its normal written form in the tool argument, not as it was spoken. Drop " +
      'spoken separators ("K dash 2" is K2, "P dash five dash two" is P52) and join spelled-out ' +
      'letters and digits ("A B C one two three" is ABC123). Add nothing the caller did not say: ' +
      '"Z K 3 F F W" is ZK3FFW, never ZEDK3FFW. Write personal names in ordinary title case ' +
      '("Rivera", not "rivera"), matching how the record would store them.\n' +
      "\nIf a lookup on something the caller spelled comes back not-found, treat a MIS-HEARING as the " +
      "most likely cause before you assume the record is missing. Spoken letters are easily confused " +
      "— F and S, B and P and V, D and G and T, M and N — so retry the lookup with the plausible " +
      "alternatives first. Only ask the caller to repeat themselves after that, and when you do, ask " +
      "for something DIFFERENT (another identifier, or just the one letter you are unsure of) rather " +
      "than making them say the same thing again. Repeating the same request gets the same audio.\n" +
      "\nNEVER ask for the same piece of information twice in one call. If you have already asked " +
      "for a name, a ZIP, or an email and the lookup still fails, asking again will fail the same " +
      "way — the caller will say the same words and the same audio will be transcribed the same " +
      "way. Switch to a DIFFERENT identifier you have not tried yet, or name the single character " +
      'you are unsure of and ask only about that ("Is that an F or an S?"). If you have exhausted ' +
      "the identifiers, say what you can still do rather than asking a fourth time.";
    const voiceRules =
      "\n\nCRITICAL OUTPUT RULES — you MUST follow these for EVERY response:\n" +
      "Your response will be spoken aloud by a TTS system and displayed as plain text.\n" +
      "- NEVER use markdown: no **, no *, no _, no #, no `, no [](), no ---\n" +
      "- NEVER use bullet points (-, *, •) or numbered lists (1., 2.)\n" +
      "- NEVER use code blocks or inline code\n" +
      "- NEVER mention tools, search, APIs, or technical failures to the user. " +
      "If a tool returns no results, just answer naturally without explaining why.\n" +
      "- Write exactly as you would say it out loud to a friend. Contractions are fine and " +
      'sound better spoken: "I\'ll", "it\'s", "don\'t".\n' +
      '- Use short conversational sentences. To list things, say "First," "Next," "Finally,"\n' +
      "- Your FIRST sentence must be at most 8 words and must carry the answer or the next " +
      "question. Never open with a preface, an acknowledgement, or a restatement of what the " +
      "caller just said. Everything else goes in later sentences. The ONE exception is a turn that " +
      "starts with a tool call and has no answer yet, which may open with a brief holding phrase — " +
      "never in front of something you already know.\n" +
      "- Keep the whole reply to 2 sentences and about 30 spoken words. Going long is the single " +
      "most expensive habit on a phone call: the longer you talk, the more likely the caller cuts " +
      "in, and everything after that point is never heard.\n" +
      'Too long: "Thanks for that. I will look up your account now. I found your account, and I ' +
      "can see two orders on it. I will check the first one to find the water bottle and then tell " +
      'you what the options are."\n' +
      'Say instead: "Found your account. Two orders — which has the water bottle?"\n' +
      "- Do NOT read out long lists. When a tool returns several items, say how many there are, name " +
      "at most two, and ask which one they mean " +
      '(e.g. "There are five items on that order — the headphones and the vacuum, plus three more. ' +
      'Which one do you want to return?"). Reading every item invites the caller to interrupt, and ' +
      "everything after the interruption is never heard.\n" +
      "- When the caller spells something (a name, email, or ID) or reads out digits, do NOT " +
      "read the whole thing back letter by letter — it is slow and invites interruptions. " +
      'Confirm briefly and move on (e.g. "Thanks, got it" or "Okay, Yusuf Rossi, ZIP 1-9-1-2-2 — one moment"). ' +
      "Only re-spell a specific character if you need to resolve a genuine ambiguity.";
    expect(result).toBe(
      DEFAULT_SYSTEM_PROMPT +
        "\n\nToday's date is Wednesday, January 15, 2025." +
        "\n\nAgent-Specific Instructions:\nCustom rules." +
        toolPreamble +
        "\n\nBuilt-in Tool Usage:\n- Guidance line." +
        voiceRules,
    );
  });
});
