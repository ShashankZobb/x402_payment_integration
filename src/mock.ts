import { requireFiniteNumber } from "./config.js";

/**
 * Mock mode: exercise the whole payment flow without spending anything.
 *
 * What stays REAL (this is the point — the parts worth testing):
 *   - the seller's 402 quote, including a per-request price
 *   - PaymentGuard: network, scheme, asset, payee, amount, balance, limit
 *   - the retry / reconciliation branches in src/pay.ts
 *   - the ledger, the chart, and every UI path
 *
 * What is SIMULATED:
 *   - the EIP-3009 signature and the facilitator round trip (no chain at all)
 *   - the USDC balance (starts at MOCK_USDC, falls as mock payments settle)
 *
 * Mock payments are written to a SEPARATE ledger file, so simulated spending
 * can never mix into real spending history or the spending chart.
 */

export function isMockMode(): boolean {
  const v = (process.env.MOCK_PAYMENTS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Run the agent loop with a scripted planner instead of calling Claude.
 * Independent of MOCK_PAYMENTS: you can have a real model spend fake money,
 * or a fake planner spend real money, or neither.
 */
export function isMockAi(): boolean {
  const v = (process.env.MOCK_AI ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Should the offline matcher be used instead of calling Claude?
 *
 * True when MOCK_AI is set, and also whenever there is no API key — without a
 * key the model simply cannot be called, so falling back to keyword matching is
 * strictly better than refusing to work. The UI is told which one ran, so a
 * keyword match is never passed off as the model's judgement.
 */
export function useOfflineAi(): boolean {
  return isMockAi() || !process.env.ANTHROPIC_API_KEY;
}

/** Why the offline matcher is in use, for display. */
export function offlineAiReason(): "flag" | "no-key" | null {
  if (isMockAi()) return "flag";
  if (!process.env.ANTHROPIC_API_KEY) return "no-key";
  return null;
}

/** Opening simulated balance; mock spend is deducted from it. */
export function mockStartBalanceUsd(): number {
  return requireFiniteNumber("MOCK_USDC", process.env.MOCK_USDC, 25);
}

/**
 * Fraction of mock settlements that fail transiently (0–1), so the retry and
 * on-chain-reconciliation branches can be exercised deliberately rather than
 * waiting for the public facilitator to collide with itself.
 */
export function mockFailRate(): number {
  const n = requireFiniteNumber("MOCK_FAIL_RATE", process.env.MOCK_FAIL_RATE, 0);
  return Math.min(Math.max(n, 0), 1);
}

/** A tx id that is obviously not a real hash — never links to an explorer. */
export function mockTxId(): string {
  return "mock-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** One line the user sees whenever mock mode is on, so it is never a surprise. */
export const MOCK_BANNER =
  "MOCK MODE — no real USDC moves, no chain calls. Unset MOCK_PAYMENTS to spend for real.";
