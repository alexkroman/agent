// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 21.
 *
 * A roadside desk as it was declared at epoch 21 — the AssemblyAI pipeline, the
 * silence policy, the barge-in tuning, and the session-event handlers that keep
 * its own log. It must keep compiling for as long as that epoch is advertised
 * as supported.
 *
 * ## What moved, and why epoch 21 survives it
 *
 * `AgentDef` gained one OPTIONAL field — `dialogs`, the array whose declaration
 * is what wires a {@link dialog}'s session-event transitions, per-state
 * deadlines and voice knobs to the runtime — and the capability gained the
 * element type it is written in (`AnyDialog`, declared on `aai:dialog`, where
 * the concept lives). The export list grew; nothing in it changed shape.
 *
 * So epoch 21 survives by being the case the field was designed around: an
 * agent that declares no dialogs. What such an agent GETS is unchanged too,
 * which is the part worth stating, because the sibling case is not — a dialog
 * that exists but is not listed here still gates its tools exactly as it did,
 * and simply receives no events, arms no deadline and varies no knob. The field
 * is opt-IN to the wiring rather than opt-in to the primitive, and this file is
 * the proof that not opting in costs an author nothing.
 *
 * **The directions that WOULD break this file**: `dialogs` becoming REQUIRED,
 * or the params union losing one of its misuse arms so that `voice` alongside
 * the preset's own `tts` stops being an error; `silencePrompt` ceasing to be
 * legal without a `silenceTimeoutMs` beside it, which `assertSilencePolicy`
 * decides; the pipeline tuning fields moving off `AgentDef` onto a nested
 * block; and {@link SessionEventHandlers} losing its `"*"` key or its
 * per-event narrowing, which is what types the two inline handlers below
 * without an annotation or a cast at either call site.
 */

import { agent, assemblyAIPipeline } from "../../../index.ts";

/** The desk, with no `dialogs` — the shape epoch 21 could declare. */
export const desk = agent({
  name: "Roadside Desk",
  systemPrompt: "You dispatch roadside assistance. Be brief; the caller is on a hard shoulder.",
  greeting: "Roadside assistance — are you somewhere safe?",
  ...assemblyAIPipeline(),
  maxSteps: 6,
  temperature: 0.3,
  silenceTimeoutMs: 8000,
  silencePrompt: "Ask whether they are still there.",
  minBargeInWords: 2,
  interruptionMinDurationMs: 300,
  // Declared INLINE, which is what exercises the mapped half of
  // {@link SessionEventHandlers}: the key is what narrows the parameter, so
  // `toolName` resolves with no annotation and no cast at the call site.
  events: {
    "tool.called": (event) => {
      void event.toolName;
    },
    "user-transcript.committed": (event) => {
      void event.text;
    },
    "*": (event) => {
      void event.type;
    },
  },
});
