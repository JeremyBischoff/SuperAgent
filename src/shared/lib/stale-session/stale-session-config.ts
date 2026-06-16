// Tunable in code only (not user settings, not UI). Calibrate from real usage.
// See docs/superpowers/specs/2026-06-15-stale-session-prompt-design.md.

/** Idle gap after which a returning user is prompted. Default 6h. */
export const STALE_TIME_GAP_MS = 6 * 60 * 60 * 1000

/** Current context occupancy (tokens) above which the session is "expensive now".
 *  Only fires in combination with the idle gate (AND). */
export const STALE_CONTEXT_TOKENS = 100_000

/** Token budget for what we feed the summarizer (Haiku ~200k window minus headroom
 *  for the instruction + output). */
export const SUMMARY_INPUT_BUDGET_TOKENS = 150_000

/** Max output tokens for the summary generation. */
export const SUMMARY_MAX_TOKENS = 700

/** Max wait for summary generation before treating it as a failure. */
export const SUMMARY_TIMEOUT_MS = 15_000
