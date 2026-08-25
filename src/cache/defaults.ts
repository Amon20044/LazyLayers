export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_L1_MAX_ENTRIES = 1_000;
export const DEFAULT_INFLIGHT_TTL_MS = 5_000;

/**
 * Safety defaults.
 *
 * Every feature below is opt-out rather than opt-in. A cache that only protects
 * you once you have read the whole options reference protects nobody on their
 * first deploy, which is exactly when the protection matters most.
 *
 * The numbers are deliberately conservative: large enough that a healthy system
 * never notices them, small enough that an unhealthy one degrades instead of
 * piling up work.
 */

/** How long a value stays usable as a fallback past its normal expiry. */
export const DEFAULT_STALE_TTL_MS = 30 * 1_000;

/** How long "this key does not exist" is remembered. */
export const DEFAULT_NEGATIVE_TTL_MS = 10 * 1_000;

/** Ceiling on remembered misses, so a scan for absent keys cannot grow the heap. */
export const DEFAULT_NEGATIVE_MAX_ENTRIES = 10_000;

/**
 * Ceiling on a single loader call. Generous on purpose: this exists to stop a
 * loader that will never return, not to enforce a latency budget.
 */
export const DEFAULT_LOADER_HARD_TIMEOUT_MS = 10 * 1_000;

/** Consecutive failures before a circuit breaker opens. */
export const DEFAULT_BREAKER_FAILURE_THRESHOLD = 3;

/** How long a breaker stays open before probing again. */
export const DEFAULT_BREAKER_COOLDOWN_MS = 30 * 1_000;

/** Lifetime of a distributed lock, and how long a caller waits to acquire one. */
export const DEFAULT_LOCK_TTL_MS = 10_000;
export const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 2_000;
export const DEFAULT_LOCK_POLL_MS = 50;
