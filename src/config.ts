import "dotenv/config";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readSettings } from "./settings.js";

/**
 * Single source of truth for every tunable in the project.
 *
 * Rule: anything that bounds spending is validated here and FAILS CLOSED.
 * A malformed MAX_BUDGET_USD used to become NaN, and `price - NaN > 1e-9`
 * is false — which silently disabled the budget guard entirely. Numbers that
 * gate money must be finite or the process must not start.
 */

export const NETWORK = "base-sepolia" as const;
export const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org";

/**
 * Circle USDC on Base Sepolia. The agent refuses to pay in anything else.
 *
 * Verified on-chain: name=USDC, symbol=USDC, decimals=6.
 * This repo previously used 0x036CbD53842c5426634e7920A7cD959F47Ca7125 — same
 * first 23 characters, but NO CONTRACT IS DEPLOYED THERE. Every balanceOf call
 * against it failed, was swallowed by a `catch { usdc = 0 }`, and reported a
 * zero balance for wallets that were in fact funded.
 */
export const USDC_ADDRESS = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
export const USDC_DECIMALS = 6;

/**
 * The enforced limit is PER TRANSACTION: no single payment may exceed it.
 * It is not a running total — ten calls at the limit are ten allowed payments.
 */
export const DEFAULT_MAX_PER_TX_USD = 0.05;
/** Hard ceiling. No caller — including the dashboard — may request more. */
/**
 * The most MAX_PER_TX_USD itself may be set to.
 *
 * This bounds the CONFIGURED limit, not what you may type: a price or an
 * auto-buy threshold you enter is no longer rejected for being large, because
 * PaymentGuard refuses anything over the per-transaction limit at signing time
 * regardless, and that is the check that actually protects the wallet.
 */
export const PER_TX_CEILING_USD = 5;

export class ConfigError extends Error {}

/** Parse a money/threshold env var, rejecting NaN, Infinity and negatives. */
export function requireFiniteNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigError(`${name} must be a finite non-negative number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Same validation, but for untrusted input (query strings, which may be arrays). */
export function parseBudgetInput(raw: unknown): number | null {
  if (Array.isArray(raw)) return null; // ?limit=1&limit=2 → "1,2" → NaN; reject outright
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, PER_TX_CEILING_USD);
}

/** Smallest chargeable amount: one USDC atom shy of pointless, 4dp is plenty. */
export const MIN_PRICE_USD = 0.0001;

/**
 * How long one paid request may take before it is abandoned, retries included.
 *
 * Settlement goes through a public facilitator and a testnet RPC, so a call can
 * hang rather than fail. Abandoning it is safe: a timeout is exactly the
 * ambiguous case that src/settlement.ts resolves by asking USDC whether the
 * authorization was consumed, so the ledger stays correct either way.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
export const MIN_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_REQUEST_TIMEOUT_MS = 180_000;

export function requestTimeoutMs(): number {
  const n = requireFiniteNumber("REQUEST_TIMEOUT_MS", process.env.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
  return Math.min(Math.max(n, MIN_REQUEST_TIMEOUT_MS), MAX_REQUEST_TIMEOUT_MS);
}

export type PriceParse =
  | { ok: true; usd: number }
  | { ok: false; reason: "empty"; message: string }
  | { ok: false; reason: "not-a-number" | "negative" | "zero" | "too-small"; message: string };

/**
 * Validate a price the caller asked the seller to charge.
 *
 * Reports WHY a value was rejected rather than a single catch-all: "not a
 * number" and "negative" are different mistakes and deserve different advice.
 * `empty` is not an error — it means "use the seller's configured price".
 */
export function validatePriceInput(raw: unknown): PriceParse {
  if (Array.isArray(raw)) {
    return { ok: false, reason: "not-a-number", message: "Send a single price, not a list." };
  }
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  if (text === "") {
    return { ok: false, reason: "empty", message: "No price given; using the service's default." };
  }

  // Accept a leading $ and thousands separators, so "$1,000" reads as a number
  // rather than as gibberish.
  const cleaned = text.replace(/^\$/, "").replace(/,/g, "").trim();
  const n = Number(cleaned);

  if (!Number.isFinite(n)) {
    return {
      ok: false,
      reason: "not-a-number",
      message: `"${text}" is not a number. Enter an amount like 0.01.`,
    };
  }
  if (n < 0) {
    return {
      ok: false,
      reason: "negative",
      message: "A negative price is not allowed. Enter an amount like 0.01.",
    };
  }
  if (n === 0) {
    return { ok: false, reason: "zero", message: "Price must be greater than zero." };
  }
  if (n < MIN_PRICE_USD) {
    return {
      ok: false,
      reason: "too-small",
      message: `The smallest chargeable price is $${MIN_PRICE_USD}. ${fmtUsd(n)} is below it.`,
    };
  }
  // USDC has 6 decimals; anything finer is not payable.
  return { ok: true, usd: Math.round(n * 1e6) / 1e6 };
}

/** Convenience wrapper for callers that only need the value or nothing. */
export function parsePriceInput(raw: unknown): number | null {
  const r = validatePriceInput(raw);
  return r.ok ? r.usd : null;
}

/**
 * The per-transaction cap. `MAX_BUDGET_USD` is still honoured as a legacy
 * alias so existing .env files keep working, but it now means "per payment"
 * rather than "per day".
 */
export function maxPerTxUsd(): number {
  // A limit set from the dashboard wins over .env. Still validated, because an
  // unusable number here disables the only check standing between a
  // non-deterministic agent and the wallet.
  const override = readSettings().maxPerTxUsd;
  if (override !== undefined) {
    if (!Number.isFinite(override) || override <= 0) {
      throw new ConfigError(
        `the saved per-transaction limit is not a positive number (${JSON.stringify(override)}). ` +
          `Fix or delete ${"`.settings.json`"} to fall back to MAX_PER_TX_USD.`,
      );
    }
    return override;
  }
  const raw = process.env.MAX_PER_TX_USD ?? process.env.MAX_BUDGET_USD;
  const name = process.env.MAX_PER_TX_USD !== undefined ? "MAX_PER_TX_USD" : "MAX_BUDGET_USD";
  return requireFiniteNumber(name, raw, DEFAULT_MAX_PER_TX_USD);
}

/** The .env default, ignoring any dashboard override. Shown as "reset to". */
export function envMaxPerTxUsd(): number {
  const raw = process.env.MAX_PER_TX_USD ?? process.env.MAX_BUDGET_USD;
  const name = process.env.MAX_PER_TX_USD !== undefined ? "MAX_PER_TX_USD" : "MAX_BUDGET_USD";
  return requireFiniteNumber(name, raw, DEFAULT_MAX_PER_TX_USD);
}

/**
 * Optional cumulative ceiling, OFF by default. Unset means no running total is
 * enforced — every payment is judged purely on its own size. Set MAX_TOTAL_USD
 * only if you also want a cumulative stop on top of the per-transaction cap.
 */
export function maxTotalUsd(): number | null {
  const raw = process.env.MAX_TOTAL_USD;
  if (raw === undefined || raw.trim() === "") return null;
  return requireFiniteNumber("MAX_TOTAL_USD", raw, Number.POSITIVE_INFINITY);
}

/**
 * The linked account: derived from the private key, never from a stale
 * hardcoded literal. AGENT_ADDRESS in .env is treated as a hint and is
 * cross-checked so a half-rotated .env fails loudly instead of funding
 * a wallet the agent cannot spend from.
 */
export function agentAccount(): { address: Address; privateKey: Hex } {
  const privateKey = (process.env.AGENT_PRIVATE_KEY ?? "") as Hex;
  if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
    throw new ConfigError("Missing or malformed AGENT_PRIVATE_KEY in .env. Run `npm run wallets` first.");
  }
  const address = privateKeyToAccount(privateKey).address;
  const declared = process.env.AGENT_ADDRESS;
  if (declared && getAddress(declared) !== address) {
    throw new ConfigError(
      `AGENT_ADDRESS (${getAddress(declared)}) does not match AGENT_PRIVATE_KEY (${address}). ` +
        `Your .env is out of sync — rerun \`npm run wallets\` or remove AGENT_ADDRESS.`,
    );
  }
  return { address, privateKey };
}

/** Read-only view for the server: address without ever touching the key. */
export function agentAddressOrNull(): Address | null {
  try {
    return agentAccount().address;
  } catch {
    return null;
  }
}

export function payToAddress(): Address {
  const raw = process.env.SERVER_PAYTO ?? "";
  if (!raw.startsWith("0x")) {
    throw new ConfigError("Missing SERVER_PAYTO in .env. Run `npm run wallets` first.");
  }
  return getAddress(raw);
}

/**
 * The seller account — the wallet that RECEIVES payments.
 *
 * Receiving only needs SERVER_PAYTO, so the key is optional and everything else
 * runs without it. But without the key those earnings can never be moved: the
 * first version of this project generated a seller keypair, kept the address and
 * threw the key away, which quietly stranded every payment ever made. Holding
 * the key is what makes `npm run sweep` possible.
 */
export function sellerAccount(): { address: Address; privateKey: Hex } {
  const privateKey = (process.env.SERVER_PRIVATE_KEY ?? "") as Hex;
  if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
    throw new ConfigError(
      "No usable SERVER_PRIVATE_KEY in .env, so funds sent to SERVER_PAYTO cannot be moved.\n" +
        "  Run `npm run wallets` to create a seller wallet whose key is saved.\n" +
        "  Note: that changes SERVER_PAYTO — anything already paid to the old address stays there.",
    );
  }
  const address = privateKeyToAccount(privateKey).address;
  const declared = process.env.SERVER_PAYTO;
  if (declared && getAddress(declared) !== address) {
    throw new ConfigError(
      `SERVER_PAYTO (${getAddress(declared)}) does not match SERVER_PRIVATE_KEY (${address}). ` +
        `Your .env is out of sync — payments would go somewhere you cannot spend from.`,
    );
  }
  return { address, privateKey };
}

/** True when seller earnings are recoverable (i.e. a matching key is present). */
export function hasSellerKey(): boolean {
  try {
    sellerAccount();
    return true;
  } catch {
    return false;
  }
}

/** Smart money formatting: whole dollars stay clean ($10), tiny budgets keep precision. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "unknown";
  if (n === 0) return "$0";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  // Number() drops the trailing zeros toPrecision leaves behind ($0.000010).
  return `$${Number(n.toPrecision(2))}`;
}

/** Exit with a readable message instead of a stack trace for config problems. */
export function failClosed(e: unknown): never {
  if (e instanceof ConfigError) {
    console.error(`[config] ${e.message}`);
    process.exit(1);
  }
  throw e;
}
