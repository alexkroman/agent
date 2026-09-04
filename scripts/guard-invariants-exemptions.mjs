// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate's exemption table, split out of `guard-invariants.mjs` when that file
 * passed the 500-line source cap — the same reason `guard-invariants-rules.mjs`
 * became a barrel over four rule groups.
 *
 * It is DATA about which files a rule may not look at, which is a scope concern
 * rather than gate machinery, and it is the part that grows: every new primitive
 * whose implementation IS the anti-pattern lands here.
 *
 * This module is itself in the table with `"*"`, and has to be: the prose below
 * quotes the banned spellings it is explaining (`setTimeout(r, 0)` among them),
 * so a line rule scanning it would report its own documentation as a violation.
 * That is the fifth time this repo has paid for a self-referential file, and the
 * reason the entry is added in the same commit as the split.
 */

/**
 * Files whose CONTENT is a description of the thing being banned, and which
 * therefore match their own rule. Each is a primitive's implementation or its
 * doc comment; excluding them is not an exemption, it is the difference between
 * scanning call sites and scanning the definition every call site should use.
 *
 * This trap has already cost real time twice in this repo — the escape-hatch
 * gate counted its own pattern list, and then counted its own baseline file.
 *
 * **The exemption is PER RULE, not per file**, and that distinction was bought
 * rather than designed in. This was a flat `Set` of paths skipped by every rule,
 * which is a different and much broader claim: `host/_test-utils.ts` is on it
 * because rule 4's doc quotes the `setTimeout(r, 0)` shadowing bug, and that made
 * the file invisible to rule 16 as well — a rule whose whole subject is the four
 * test harnesses, one of which is that file. It would have reported `0 ✓` over a
 * harness free to grow its callback stub back, which is precisely the
 * silently-blind shape the set exists to prevent. `"*"` still means every rule,
 * and is right only for the gate's own machinery.
 *
 * **Two blanket `"*"` entries were ordinary SDK modules**, and both are gone.
 * `sdk/epoch.ts` and `sdk/session-slot.ts` were exempt from every line rule —
 * twelve of them, including `p-timeout`, the hand-rolled sleep and the record
 * guard — and `session-slot.ts` is the state primitive every stateful template
 * goes through. The justification recorded for it named RETIRED rule 6, a rule
 * about `ctx.state as T` casts in a template, which is neither this file nor a
 * live rule. Measured before removing them: neither module matched a single
 * line rule, so the exemptions were pure latent surface — which is what makes
 * dropping them free and what would have made keeping them expensive.
 */
/**
 * `"*"` exempts a file from EVERY rule; an array exempts it from the named ones.
 *
 * The entries are annotated separately from the `Map` they build: with two
 * entry shapes in one literal, inference settles on the FIRST (`"*"`) and every
 * per-rule entry below is then rejected against it. Naming the pair type here
 * is what lets both shapes through — and keeps a third, misspelled shape out.
 *
 * @type {readonly (readonly [file: string, scope: "*" | string[]])[]}
 */
export const SELF_REFERENTIAL_ENTRIES = [
  ["scripts/guard-invariants.mjs", "*"],
  // This file. Its prose quotes the spellings it is explaining.
  ["scripts/guard-invariants-exemptions.mjs", "*"],
  // The rule definitions. Every LINE rule's `label` and `re` is a description of
  // the thing it bans, so these files match most of their own rules — and the
  // set has to name ALL of them. `guard-invariants-rules.mjs` was one 649-line
  // module until it passed the source cap; the split into a barrel plus an ERE
  // vocabulary, a scopes module and FOUR rule groups multiplies this trap by
  // six, which AGENTS.md records having already been paid for four times.
  //
  // `-rules-timing.mjs` and `-nodes.mjs` are deliberately ABSENT: those are the
  // node rules, and a node rule's own definition cannot match it, because a
  // remedy or a sample quoting the anti-pattern is a string literal and a
  // string literal is not a call. That is not a claim taken on trust — the
  // entry was removed and the gate stayed green.
  ["scripts/guard-invariants-rules.mjs", "*"],
  ["scripts/guard-invariants-ere.mjs", "*"],
  ["scripts/guard-invariants-scopes.mjs", "*"],
  ["scripts/guard-invariants-rules-workflow.mjs", "*"],
  ["scripts/guard-invariants-rules-shape.mjs", "*"],
  ["scripts/guard-invariants-rules-state.mjs", "*"],
  ["scripts/guard-invariants-baseline.json", "*"],
  // The spec that proves each rule still matches. Its samples ARE the
  // anti-patterns, spelled out on purpose — it exists because a pattern
  // matching nothing prints the same checkmark as a rule being upheld.
  ["packages/aai-templates/src/guard-invariants-gate.test.ts", "*"],
  // The primitives the rules point AT — each exempt from ITS OWN rule only.
  ["packages/aai/src/sdk/omit-undefined.ts", ["rule2_spreadTernary"]], // its doc shows the banned spelling
  ["packages/aai/src/sdk/keyed-lock.ts", ["rule9_handRolledKeyedLock"]], // rule 9 IS this implementation
  ["packages/aai/src/sdk/owned-map.ts", ["rule8_handRolledOwnedMap"]], // rule 8 IS this implementation
  // All three DEFINE `tick()`, so all three are the remedy rather than a
  // violation. The split duplicated the helper: aai-runtime owns the full set,
  // packages/aai keeps the four its remaining host/ modules need, and aai-ui
  // spells it again because those modules are `_`-internal to their packages.
  //
  // The aai-ui entry was ADDED BY THE PARSE. That copy writes its executor as a
  // block, so the line rule could not see it, and its own doc comment says as
  // much — "the one occurrence in this package was in no baseline and reported
  // by nothing". An exemption you can only write once the gate can see the file
  // is the difference between a rule that is at zero and one that is blind.
  ["packages/aai-runtime/src/_test-utils.ts", ["rule4_inlineTickPromise"]],
  ["packages/aai-ui/src/_react-test-utils.ts", ["rule4_inlineTickPromise"]],
  ["packages/aai/src/host/_test-utils.ts", ["rule4_inlineTickPromise"]], // its doc quotes the shadowing bug
  ["packages/aai/src/sdk/is-record.ts", ["rule17_openCodedRecordGuard"]], // rule 17 IS `isRecord`'s body
  ["packages/aai/src/sdk/jittered-backoff.ts", ["rule31_handRolledJitter"]], // rule 31 IS this body
];
