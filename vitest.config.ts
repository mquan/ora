import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The web SPA (web/) is its own Vite package with React/jsdom-flavored tests — never run them here.
    exclude: ["web/**", "node_modules/**", "dist/**"],
  },
});
