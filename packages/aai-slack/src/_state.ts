import humanId from "human-id";

export type ThreadState = {
  slug: string;
  sessionId?: string;
  isNew: boolean;
};

const threads = new Map<string, ThreadState>();

export function getOrCreateThread(threadTs: string): ThreadState {
  const existing = threads.get(threadTs);
  if (existing) return { ...existing, isNew: false };

  const state: ThreadState = {
    slug: humanId({ separator: "-", capitalize: false }),
    isNew: true,
  };
  threads.set(threadTs, state);
  return state;
}

export function hasThread(threadTs: string): boolean {
  return threads.has(threadTs);
}

export function setSessionId(threadTs: string, sessionId: string): void {
  const state = threads.get(threadTs);
  if (state) state.sessionId = sessionId;
}
