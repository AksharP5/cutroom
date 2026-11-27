import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // CodeMirror's packages install a newer view beside the pinned one. Extensions must share one
  // view and its facet identities.
  resolve: { dedupe: ["@codemirror/view", "@codemirror/state"] },
  // Lightning CSS expands the tokens' @custom-media breakpoints, which browsers cannot read yet.
  css: {
    transformer: "lightningcss",
    lightningcss: { drafts: { customMedia: true } },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4317",
      "/__cutroom": { target: "http://127.0.0.1:4317", ws: true },
    },
  },
  build: { target: "es2023", sourcemap: true, chunkSizeWarningLimit: 1500 },
});
