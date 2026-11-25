import { defineConfig } from "vitest/config";

// Runs only the extraction task (evals/extraction/run.task.ts), never part of `npm test`.
export default defineConfig({
  test: {
    include: ["extraction/run.task.ts"],
    testTimeout: 48 * 3_600_000,
  },
});
