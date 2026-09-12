import type { Address } from "viem";
import { isAuthorizationUsed } from "./chain.js";
import { isMockMode } from "./mock.js";

/**
 * Working out what actually happened when a payment fails.
 *
 * A 402 back from the seller covers two very different situations:
 *   - VERIFY failed — the facilitator rejected the payload. Nothing was
 *     submitted, no funds moved.
 *   - SETTLE failed — the payload was fine and a transaction was attempted,
 *     but the send did not stick. Whether money moved is genuinely unknown
 *     from the error alone.
 *
 * The second case is common against the public x402.org facilitator, whose
 * relayer submits transactions for many users from one wallet. Two concurrent
 * settlements pick the same account nonce and the RPC rejects the loser with
 * "replacement transaction underpriced". That is the facilitator colliding
 * with itself — the payer's signature was perfectly valid.
 *
 * Rather than guess, `confirmOnChain` asks USDC whether the authorization was
 * consumed, which is an exact answer.
 */

export type Authorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
};

/** Pull the human-meaningful line out of the facilitator's multi-KB error dump. */
export function shortFacilitatorError(raw: unknown): string {
  const s = String(raw ?? "");
  if (!s) return "unknown";
  const details = s.match(/Details:\s*(.+)/)?.[1]?.trim();
  if (details) return details;
  return s.split("\n")[0]!.trim().slice(0, 160);
}

/**
 * Transient, relayer-side conditions. The payer did nothing wrong and the same
 * request will usually succeed moments later.
 */
export function isTransientSettlementError(raw: unknown): boolean {
  return /replacement transaction underpriced|nonce too low|already known|transaction underpriced|timeout|ECONNRESET|502|503|504/i.test(
    String(raw ?? ""),
  );
}

/**
 * Recover the signed authorization from the failed request. x402-axios sets
 * X-PAYMENT on the retried request, and axios hands that config back on the
 * error, so the exact nonce that was signed is recoverable.
 */
export function authorizationFromError(err: any): Authorization | null {
  try {
    const headers = err?.config?.headers ?? {};
    const raw = headers["X-PAYMENT"] ?? headers["x-payment"] ?? headers.get?.("X-PAYMENT");
    if (!raw) return null;
    const decoded = JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
    const auth = decoded?.payload?.authorization;
    if (!auth?.nonce || !auth?.from) return null;
    return auth as Authorization;
  } catch {
    return null;
  }
}

export type Outcome =
  | { settled: true; via: "on-chain" }
  | { settled: false; via: "on-chain" }
  | { settled: null; via: "unknown" };

/**
 * Ask the chain whether the authorization was consumed. `settled: null` means
 * we could not find out — the caller must then assume the worst and record the
 * payment as unconfirmed rather than silently dropping it.
 */
export async function confirmOnChain(auth: Authorization | null): Promise<Outcome> {
  // In mock mode nothing is ever signed or submitted, so a failure moved no
  // funds by construction. Returning "unknown" here would wrongly park the
  // payment as unconfirmed and skip the retry path this mode exists to test.
  if (isMockMode()) return { settled: false, via: "on-chain" };
  if (!auth) return { settled: null, via: "unknown" };
  try {
    const used = await isAuthorizationUsed(auth.from, auth.nonce);
    return { settled: used, via: "on-chain" };
  } catch {
    return { settled: null, via: "unknown" };
  }
}
