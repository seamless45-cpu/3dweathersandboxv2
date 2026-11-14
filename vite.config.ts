import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  server: {
    host: "0.0.0.0",
    // Arena serves previews from dynamic *.e2b.app hostnames.
    allowedHosts: [".e2b.app"],
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" },
  },
  preview: {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
