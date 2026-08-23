import { z } from "zod";
import { CATEGORIES, type Category, MOODS, type Mood, nightSlot, type Rec } from "../shared.ts";

const PICKS: Record<Category, Record<Mood, string[]>> = {
  movie: {
    chill: ["Lost in Translation", "The Grand Budapest Hotel", "Amelie"],
    intense: ["Inception", "Interstellar", "The Dark Knight"],
    cozy: ["When Harry Met Sally", "The Holiday", "Paddington 2"],
    spooky: ["The Shining", "Get Out", "Hereditary"],
    funny: ["The Big Lebowski", "Airplane!", "Superbad"],
  },
  music: {
    chill: ["Khruangbin — Con Todo El Mundo", "Tycho — Dive", "Bonobo — Migration"],
    intense: ["Radiohead — OK Computer", "Tool — Lateralus", "Deftones — White Pony"],
    cozy: [
      "Norah Jones — Come Away with Me",
      "Iron & Wine — Our Endless Numbered Days",
      "Bon Iver — For Emma, Forever Ago",
    ],
    spooky: [
      "Portishead — Dummy",
      "Massive Attack — Mezzanine",
      "Boards of Canada — Music Has the Right to Children",
    ],
    funny: [
      "Weird Al — Running with Scissors",
      "Flight of the Conchords — S/T",
      "Tenacious D — S/T",
    ],
  },
  book: {
    chill: ["Norwegian Wood — Murakami", "The Alchemist — Coelho", "Siddhartha — Hesse"],
    intense: ["Blood Meridian — McCarthy", "House of Leaves — Danielewski", "Neuromancer — Gibson"],
    cozy: [
      "The House in the Cerulean Sea — Klune",
      "A Man Called Ove — Backman",
      "Anxious People — Backman",
    ],
    spooky: [
      "The Haunting of Hill House — Jackson",
      "Mexican Gothic — Moreno-Garcia",
      "The Turn of the Screw — James",
    ],
    funny: ["Good Omens — Pratchett & Gaiman", "Hitchhiker's Guide — Adams", "Catch-22 — Heller"],
  },
};

/**
 * `updateTool` rather than `tool`: the body is handed the night's own draft and
 * whatever it leaves behind is stored, so the log the client renders and the
 * value this returns to the model are written in one place. It must be
 * SYNCHRONOUS — the mutation is committed when it returns.
 */
export default nightSlot.updateTool({
  description: "Get recommendations for movies, music, or books based on mood.",
  inputSchema: z.object({
    category: z.enum(CATEGORIES),
    mood: z.enum(MOODS),
  }),
  execute: (args, night, ctx) => {
    const result: Rec = {
      category: args.category,
      mood: args.mood,
      picks: PICKS[args.category][args.mood],
    };
    night.recs.unshift(result);
    // A NUDGE, not state: shown once, when the third pick lands. It is a
    // `ctx.send` rather than a field on the projection precisely because
    // replaying it on every reconnect would be nagging — the distinction the
    // client's header comment spells out.
    if (night.recs.length === 3) {
      ctx.send("wind_down", "Three picks in. Want me to work out your bedtime?");
    }
    return result;
  },
});
