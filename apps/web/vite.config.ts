import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7700",
      "/mcp": "http://localhost:7700",
      "/ws": { target: "ws://localhost:7700", ws: true },
    },
  },
});
