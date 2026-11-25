import { defineConfig } from "vitest/config";

// Runs only the embedding task (evals/retrieval/embed.task.ts), never part of `npm test`:
// the default test pattern (*.test.ts) does not match it.
export default defineConfig({
  test: {
    include: ["retrieval/embed.task.ts"],
    testTimeout: 24 * 3_600_000,
  },
});
