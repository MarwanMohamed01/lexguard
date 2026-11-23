// Made-up tenant keys for tests only (shared by vitest.config.ts, which runs in Node, and the
// tests, which run in workerd). Built at runtime so no key-shaped literal sits in the repo.
export const TEST_KEYS = {
  acme: `lg_${"A".repeat(43)}`,
  globex: `lg_${"B".repeat(43)}`,
  quota: `lg_${"Q".repeat(43)}`,
} as const;
