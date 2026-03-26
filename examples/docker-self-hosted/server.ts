import { createServer } from "@alexkroman1/aai/server";
import agent from "./agent.ts";

const port = Number(process.env.PORT) || 3000;

const server = createServer({
  agent,
  authToken: process.env.AUTH_TOKEN,
});

await server.listen(port);
console.log(`Weather Assistant listening on http://localhost:${port}`);

// Graceful shutdown for Docker (SIGTERM) and Ctrl+C (SIGINT)
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down...`);
    await server.close();
    process.exit(0);
  });
}
