import { defineConfig } from "vitest/config";

// The extraction baselines on all 510 CUAD contracts (evals/extraction/extraction.test.ts with
// EXTRACTION_FULL=1); writes results/cuad-extraction-baselines.json. Not part of `npm test`.
export default defineConfig({
  test: {
    include: ["extraction/extraction.test.ts"],
    env: { EXTRACTION_FULL: "1" },
    hookTimeout: 3_600_000,
  },
});
