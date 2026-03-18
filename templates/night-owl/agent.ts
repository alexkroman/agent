import { defineAgent } from "@alexkroman1/aai";
import { z } from "zod";

const PICKS: Record<string, Record<string, string[]>> = {
  movie: {
    chill: ["Lost in Translation", "The Grand Budapest Hotel", "Amelie"],
    intense: ["Inception", "Interstellar", "The Dark Knight"],
    cozy: ["When Harry Met Sally", "The Holiday", "Paddington 2"],
    spooky: ["The Shining", "Get Out", "Hereditary"],
    funny: ["The Big Lebowski", "Airplane!", "Superbad"],
  },
  music: {
    chill: [
      "Khruangbin — Con Todo El Mundo",
      "Tycho — Dive",
      "Bonobo — Migration",
    ],
    intense: [
      "Radiohead — OK Computer",
      "Tool — Lateralus",
      "Deftones — White Pony",
    ],
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
    chill: [
      "Norwegian Wood — Murakami",
      "The Alchemist — Coelho",
      "Siddhartha — Hesse",
    ],
    intense: [
      "Blood Meridian — McCarthy",
      "House of Leaves — Danielewski",
      "Neuromancer — Gibson",
    ],
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
    funny: [
      "Good Omens — Pratchett & Gaiman",
      "Hitchhiker's Guide — Adams",
      "Catch-22 — Heller",
    ],
  },
};

export default defineAgent({
  name: "Night Owl",
  instructions:
    `You are Night Owl, a cozy evening companion. You help people wind down, recommend entertainment, and share interesting facts about the night sky. Keep your tone warm and relaxed. Use short, conversational responses.

Use run_code for sleep calculations:
- Each sleep cycle is 90 minutes, plus 15 minutes to fall asleep
- Bedtime = wake_time - (cycles * 90 + 15) minutes
- If result is negative, add 1440 (24 hours in minutes)
- Format as HH:MM`,
  greeting:
    "Hey there, night owl. Try asking me for a cozy movie recommendation, or tell me what time you need to wake up and I'll calculate the best time to fall asleep.",
  builtinTools: ["run_code"],
  tools: {
    recommend: {
      description:
        "Get recommendations for movies, music, or books based on mood.",
      parameters: z.object({
        category: z.enum(["movie", "music", "book"]),
        mood: z.enum(["chill", "intense", "cozy", "spooky", "funny"]),
      }),
      execute: ({ category, mood }: { category: string; mood: string }) => {
        return {
          category,
          mood,
          picks: PICKS[category]?.[mood] ?? [],
        };
      },
    },
  },
});
