import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.sandcastle/**", "**/.tmp/**"],
    reporters: process.env.CI_AGENT ? ["agent"] : ["default"],
    silent: process.env.CI_AGENT ? "passed-only" : false,
  },
});
