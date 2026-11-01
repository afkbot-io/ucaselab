import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
const apiTarget = process.env.UCASELAB_API_URL || "http://127.0.0.1:8017";
const securityHeaders = () =>
  Object.fromEntries(
    [
      ...readFileSync(
        new URL("../../infra/security-headers.conf", import.meta.url),
        "utf8",
      ).matchAll(/add_header ([\w-]+) (?:"([^"]+)"|([^;\s]+)) always;/g),
    ].map((match) => [match[1], match[2] || match[3]]),
  );
export default defineConfig(({ isPreview }) => ({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": apiTarget,
      "/mcp": apiTarget,
      "/ai.md": apiTarget,
    },
  },
  // Preview the built application with the same response policy as production nginx.
  preview: { headers: isPreview ? securityHeaders() : {} },
  build: {
    // Keep fonts as same-origin files: production CSP intentionally disallows data: fonts.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          markdown: ["react-markdown"],
        },
      },
    },
  },
}));
