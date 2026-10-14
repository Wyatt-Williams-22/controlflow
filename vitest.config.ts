import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // The real package throws outside a React Server Component bundle.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
