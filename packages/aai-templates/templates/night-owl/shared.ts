export const CATEGORIES = ["movie", "music", "book"] as const;
export const MOODS = ["chill", "intense", "cozy", "spooky", "funny"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Mood = (typeof MOODS)[number];
