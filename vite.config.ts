import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { studioPlugin } from "./build/studioPlugin";

export default defineConfig({
  plugins: [studioPlugin(), react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@hyperframes\/studio$/,
        replacement: resolve("node_modules/@hyperframes/studio/src/index.ts"),
      },
      {
        find: "@upstream-studio",
        replacement: resolve("node_modules/@hyperframes/studio/src"),
      },
    ],
    // Extensions must share Studio's pinned CodeMirror view and facet identities.
    dedupe: [
      "react",
      "react-dom",
      "zustand",
      "@codemirror/view",
      "@codemirror/state",
    ],
  },
  define: {
    "import.meta.env.VITE_HYPERFRAMES_NO_TELEMETRY": JSON.stringify("1"),
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
