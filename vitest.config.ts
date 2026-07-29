import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
    clearMocks: true,
    restoreMocks: true,
    // Baseline env so modules that validate `process.env` at import (e.g.
    // src/config/env.ts) load cleanly under test.
    env: {
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    },
  },
});
