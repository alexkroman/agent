import { route } from "@alexkroman1/aai";
import type { History, PastConversation } from "./shared.ts";

/** Most past conversations listed: the sidebar shows recent cooking, not an archive. */
export const MAX_LISTED = 8;

/**
 * GET /api/history — what this browser's past sessions said, newest first.
 *
 * `ctx.clientTranscript` reads the runtime's own log for a `?client=` id (the page
 * mounts with `client: "auto"`, so every session from this browser shares one), the same
 * read a workflow step makes with `stepClientTranscript`. Nothing is stored by the app.
 * The id is a CLAIM, so the list says only what that browser's sessions already showed
 * on its own screen. A backend that keeps no client log (the platform's) answers none.
 */
export const history = route({
  requireClient: true,
  handler: async (req, ctx): Promise<History> => {
    const { sessions } = await ctx.clientTranscript(req.clientId);
    const conversations = sessions
      .flatMap((session): PastConversation[] => {
        const first = session.messages.find((m) => m.role === "user");
        if (first === undefined) return [];
        return [
          {
            sessionId: session.sessionId,
            startedAt: session.startedAt,
            firstLine: first.text,
            lines: session.messages.length,
          },
        ];
      })
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_LISTED);
    return { conversations };
  },
});
