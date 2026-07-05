import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build output goes to /dist. Use `npm run build` then deploy dist/.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist" },
});
