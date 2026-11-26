import { defineConfig } from "vitest/config";

// Runs only the data build (scripts/build.task.ts), never part of `npm test`. Paths are
// relative to the package folder, where `npm run build:data` runs.
export default defineConfig({
  test: { include: ["scripts/build.task.ts"] },
});
