import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
});
