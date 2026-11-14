import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api goes to the backend (8000), /ai to the AI service (8001).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/ai": { target: "http://localhost:8001", rewrite: (path) => path.replace(/^\/ai/, "") },
    },
  },
});
