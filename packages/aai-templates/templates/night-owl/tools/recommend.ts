const PICKS: Record<string, Record<string, string[]>> = {
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

export default async function execute(args: { category: string; mood: string }, _ctx: unknown) {
  return {
    category: args.category,
    mood: args.mood,
    picks: PICKS[args.category]?.[args.mood] ?? [],
  };
}
