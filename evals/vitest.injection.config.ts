import { defineConfig } from "vitest/config";

// Runs only the injection task (evals/extraction/injection.task.ts), never part of `npm test`.
export default defineConfig({
  test: {
    include: ["extraction/injection.task.ts"],
    testTimeout: 6 * 3_600_000,
  },
});
