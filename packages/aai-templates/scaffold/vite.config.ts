import { aai } from "@alexkroman1/aai/vite-plugin";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [aai(), preact(), tailwindcss()],
  resolve: {
    dedupe: ["preact", "@preact/signals"],
  },
  build: {
    target: "es2022",
    minify: true,
  },
  ssr: {
    noExternal: true,
  },
});
