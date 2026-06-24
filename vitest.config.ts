import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // The store and adapter seams are plain Node — no DOM, no browser.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
