import { pushCapped } from "@alexkroman1/aai";
import { z } from "zod";
import {
  DEFAULT_CLOCK_SEGMENTS,
  DISPOSITIONS,
  gameSlot,
  MAX_BOND,
  MAX_CLOCK_SEGMENTS,
  MAX_CLOCKS,
  MAX_NPCS,
  MAX_RESOURCE,
  MAX_SESSION_LOG,
  MIN_CLOCK_SEGMENTS,
  MIN_MOMENTUM,
  makeNpc,
  nextSeqId,
  stateSummary,
  storyFlow,
  TIME_PHASES,
  updateCrisisFlags,
} from "../shared.ts";

/**
 * Gated on `playing`: there is nothing to sync before a character exists (that
 * is `setup_character`'s whole job, and the prompt says not to call this after
 * it), and nothing to sync after the story has ended.
 *
 * It sends `SETTLED`, because moving the scene on is what SPENDS a standing
 * roll: once the narrator has changed the location or logged the scene, the
 * player's window to burn momentum on the last roll has closed.
 */
export default storyFlow.tool({
  description:
    "Lightweight state sync for during gameplay. Handles location changes, NPC additions, clock additions, time changes, and session log entries. Resource changes (health/spirit/supply/momentum) are auto-applied by action_roll — only use those fields here for manual adjustments like resting or trading. Pass only what changed.",
  when: "playing",
  inputSchema: z.object({
    location: z.string().max(200).describe("New location name").optional(),
    locationDesc: z.string().max(500).describe("Short location description").optional(),
    timeOfDay: z.enum(TIME_PHASES).describe("New time of day").optional(),
    health: z.number().int().optional(),
    spirit: z.number().int().optional(),
    supply: z.number().int().optional(),
    momentum: z.number().int().optional(),
    addNpcName: z.string().max(100).describe("New NPC name").optional(),
    addNpcDesc: z.string().max(300).describe("New NPC one-line description").optional(),
    addNpcDisposition: z.enum(DISPOSITIONS).describe("New NPC disposition").optional(),
    addNpcAgenda: z.string().max(300).describe("New NPC agenda").optional(),
    updateNpcId: z.string().max(32).describe("NPC id to update").optional(),
    updateNpcDisposition: z.enum(DISPOSITIONS).optional(),
    updateNpcBond: z.number().int().min(0).max(MAX_BOND).optional(),
    updateNpcStatus: z.enum(["active", "background", "deceased"]).optional(),
    addClockName: z.string().max(100).describe("New clock name").optional(),
    addClockType: z.enum(["threat", "progress", "scheme"]).optional(),
    addClockSegments: z
      .number()
      .int()
      .min(MIN_CLOCK_SEGMENTS)
      .max(MAX_CLOCK_SEGMENTS)
      .describe(`Number of segments, default ${DEFAULT_CLOCK_SEGMENTS}`)
      .optional(),
    addClockTrigger: z.string().max(300).describe("What happens when clock fills").optional(),
    advanceClockName: z.string().max(100).describe("Clock name to advance by 1").optional(),
    removeClockName: z.string().max(100).describe("Clock name to remove").optional(),
    advanceAct: z.boolean().describe("Move to next story act").optional(),
    storyComplete: z.boolean().describe("Mark story as complete").optional(),
    logEntry: z.string().max(500).describe("Short log entry for this scene").optional(),
  }),
  execute: (args, ctx) =>
    gameSlot.update(ctx, (state) => {
      const warnings: string[] = [];
      const clockEvents: { clock: string; trigger: string }[] = [];

      // Resources
      if (args.health !== undefined)
        state.health = Math.max(0, Math.min(MAX_RESOURCE, args.health));
      if (args.spirit !== undefined)
        state.spirit = Math.max(0, Math.min(MAX_RESOURCE, args.spirit));
      if (args.supply !== undefined)
        state.supply = Math.max(0, Math.min(MAX_RESOURCE, args.supply));
      if (args.momentum !== undefined)
        state.momentum = Math.max(MIN_MOMENTUM, Math.min(state.maxMomentum, args.momentum));

      // Location
      if (args.location !== undefined) state.currentLocation = args.location;
      if (args.locationDesc !== undefined) state.currentSceneContext = args.locationDesc;
      if (args.timeOfDay !== undefined) state.timeOfDay = args.timeOfDay;

      // Add NPC
      if (args.addNpcName) {
        if (state.npcs.length >= MAX_NPCS) {
          warnings.push(
            `NPC limit of ${MAX_NPCS} reached — mark an existing NPC deceased or background instead.`,
          );
        } else {
          state.npcs.push(
            makeNpc({
              id: nextSeqId(state.npcs, "npc"),
              name: args.addNpcName,
              description: args.addNpcDesc,
              disposition: args.addNpcDisposition,
              agenda: args.addNpcAgenda,
            }),
          );
        }
      }

      // Update NPC
      if (args.updateNpcId) {
        const npc = state.npcs.find((n) => n.id === args.updateNpcId);
        if (npc) {
          if (args.updateNpcDisposition !== undefined) npc.disposition = args.updateNpcDisposition;
          if (args.updateNpcBond !== undefined) npc.bond = args.updateNpcBond;
          if (args.updateNpcStatus !== undefined) npc.status = args.updateNpcStatus;
        } else {
          warnings.push(`No NPC with id ${args.updateNpcId}.`);
        }
      }

      // Add clock
      if (args.addClockName) {
        if (state.clocks.length >= MAX_CLOCKS) {
          warnings.push(`Clock limit of ${MAX_CLOCKS} reached — remove a finished clock first.`);
        } else {
          state.clocks.push({
            id: nextSeqId(state.clocks, "clock"),
            name: args.addClockName,
            clockType: args.addClockType ?? "threat",
            segments: args.addClockSegments ?? DEFAULT_CLOCK_SEGMENTS,
            filled: 0,
            triggerDescription: args.addClockTrigger ?? "",
          });
        }
      }

      // Advance clock
      if (args.advanceClockName) {
        const clock = state.clocks.find((c) => c.name === args.advanceClockName);
        if (clock && clock.filled < clock.segments) {
          clock.filled = Math.min(clock.segments, clock.filled + 1);
          if (clock.filled >= clock.segments) {
            clockEvents.push({ clock: clock.name, trigger: clock.triggerDescription });
          }
        }
      }

      // Remove clock
      if (args.removeClockName) {
        state.clocks = state.clocks.filter((c) => c.name !== args.removeClockName);
      }

      // Story arc
      if (args.advanceAct && state.storyBlueprint) {
        state.storyBlueprint.currentAct = Math.min(
          state.storyBlueprint.acts.length,
          state.storyBlueprint.currentAct + 1,
        );
      }
      if (args.storyComplete && state.storyBlueprint) {
        state.storyBlueprint.storyComplete = true;
      }

      // Session log
      if (args.logEntry) {
        pushCapped(
          state.sessionLog,
          {
            scene: state.sceneCount,
            summary: args.logEntry,
            location: state.currentLocation,
          },
          MAX_SESSION_LOG,
        );
      }

      // Crisis check
      updateCrisisFlags(state);

      return {
        success: true,
        ...(warnings.length > 0 ? { warnings } : {}),
        clockEvents,
        ...stateSummary(state),
      };
    }),
  sendFrom: (result) =>
    result.gameOver ? { type: "DOWNED" as const } : { type: "SETTLED" as const },
});
