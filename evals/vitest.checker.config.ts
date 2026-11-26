import { defineConfig } from "vitest/config";

// Runs only the checker task on ContractNLI (evals/contractnli/checker.task.ts), never part of
// `npm test`: it calls a model and resumes from the answer cache.
export default defineConfig({
  test: {
    include: ["contractnli/checker.task.ts"],
    testTimeout: 48 * 3_600_000,
  },
});
