// The dev server for recording (port 5180): the same app, but it never reloads the page when a
// file changes, so another edit in the checkout cannot restart a film halfway through.
//   npx vite --config promo/vite.rec.config.mjs
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "web"),
  plugins: [react()],
  server: { port: 5180, strictPort: true, hmr: false, watch: { ignored: ["**/*"] } },
});
