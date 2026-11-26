// Fake test values only (never real keys), shared by vitest.config.ts and the tests.
export const TEST_ORIGIN = "https://rulebook.test";
export const TEST_KEY = `lg_${"T".repeat(43)}`;
export const TEST_TENANT = "acme";
// Keys the stand-in main Worker answers wrongly on purpose, to prove the rulebook side checks
// its answers too: a malformed tenant ID, and a tenant for an absurdly long key.
export const KEY_WITH_BAD_TENANT = `lg_${"B".repeat(43)}`;
export const OVERLONG_KEY = `lg_${"L".repeat(200)}`;
