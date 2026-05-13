import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// During `npm run dev` we proxy /api and /ws to the backend on :3000.
// In production the frontend is served by nginx, which does the same proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/ws":  { target: "ws://localhost:3000", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
