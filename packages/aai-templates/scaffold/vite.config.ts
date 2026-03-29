import aai from "@alexkroman1/aai/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [aai()],
  resolve: {
    dedupe: ["preact", "@preact/signals"],
  },
});
