import { normalizeStrict } from './normalize.mjs';

// One historical-intent rule shared by the hook engine and the host recall view; the pattern is unchanged.
export const HISTORICAL_PATTERN = /历史|以前|曾经|演化|旧版/u;

export function hasHistoricalIntent(queryText) {
  return HISTORICAL_PATTERN.test(normalizeStrict(queryText));
}
