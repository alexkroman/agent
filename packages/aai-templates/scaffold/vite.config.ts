import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const backendPort = process.env.AAI_BACKEND_PORT ?? "3001";
const backendTarget = `http://localhost:${backendPort}`;

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  resolve: {
    dedupe: ["preact", "@preact/signals"],
  },
  server: {
    proxy: {
      "/health": backendTarget,
      "/websocket": { target: backendTarget, ws: true },
    },
  },
  build: {
    target: "es2022",
    minify: true,
  },
});
