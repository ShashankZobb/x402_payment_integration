import { getAddress, type Address } from "viem";
import { selectPaymentRequirements } from "x402/client";
import type { PaymentRequirements } from "x402/types";
import { NETWORK, USDC_ADDRESS, USDC_DECIMALS, fmtUsd } from "./config.js";
import { getUsdcBalance } from "./chain.js";
import * as ledger from "./ledger.js";

/**
 * The single enforcement point for every payment this agent makes.
 *
 * The old flow checked the budget against a quote fetched in ONE request and
 * then paid whatever a SECOND request happened to ask for — the amount that
 * actually got signed was never bounded by anything. x402-axios accepts a
 * `PaymentRequirementsSelector` which it invokes with the real requirements
 * immediately before signing, so validating here makes the check atomic with
 * the payment: whatever this function returns is exactly what gets paid, and
 * throwing aborts before any signature exists.
 */

export class PaymentBlocked extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "PaymentBlocked";
  }
}

export type GuardOptions = {
  account: Address;
  /** No single payment may exceed this. This is the enforced limit. */
  maxPerTxUsd: number;
  /**
   * Optional cumulative ceiling across payments. null (the default) means no
   * running total is enforced — each payment is judged only on its own size.
   */
  maxTotalUsd?: number | null;
  /** Only pay this specific seller. Omit to allow any payee. */
  expectedPayTo?: Address;
  /** Seed the balance instead of reading the chain (used by budget-check). */
  initialBalanceUsd?: number;
  /**
   * A price a PERSON saw and clicked Buy on.
   *
   * The per-transaction limit exists to bound an agent spending unattended; a
   * human who read the price and chose to pay it is the authorisation, so the
   * limit is waived. In its place the quote must equal exactly what was shown —
   * so there is no ceiling, but a seller cannot advertise one price and charge
   * another at checkout. Set only on human-initiated purchases; never by the
   * agent loop.
   */
  humanAuthorizedPriceUsd?: number;
};

export class PaymentGuard {
  private availableUsdc: number;
  private pending: { usd: number; task: string } | null = null;
  private lastBlock: PaymentBlocked | null = null;
  private currentTask = "unknown";

  constructor(private readonly opts: GuardOptions) {
    this.availableUsdc = opts.initialBalanceUsd ?? 0;
  }

  /** Read the on-chain USDC balance. Call at startup and to re-sync. */
  async refreshBalance(): Promise<number> {
    this.availableUsdc = await getUsdcBalance(this.opts.account);
    return this.availableUsdc;
  }

  get balance(): number {
    return this.availableUsdc;
  }

  /** Historical total. Reporting only — it does not gate payments unless
   *  maxTotalUsd is explicitly set. */
  spent(): number {
    return ledger.spentAllTime(this.opts.account);
  }

  get perTxLimit(): number {
    return this.opts.maxPerTxUsd;
  }

  /** True when this guard is acting on a person's explicit authorisation. */
  get isHumanAuthorized(): boolean {
    return this.opts.humanAuthorizedPriceUsd != null;
  }

  /** Remaining under the OPTIONAL cumulative ceiling; Infinity when unset. */
  remainingTotal(): number {
    const cap = this.opts.maxTotalUsd;
    return cap == null ? Number.POSITIVE_INFINITY : Math.max(0, cap - this.spent());
  }

  /** Label the next payment so the ledger entry is traceable. */
  beginTask(task: string): void {
    this.currentTask = task;
    this.lastBlock = null;
  }

  /**
   * Cheap pre-check so an unaffordable task skips the network round trip.
   * NOT the security boundary — `select()` is. This may be stale; that is
   * fine, because it can only cause an extra request, never an extra payment.
   */
  affordable(priceUsd: number): boolean {
    if (!Number.isFinite(priceUsd)) return false;
    // A human-authorised purchase is not bound by the limit, only by funds.
    const withinPolicy =
      this.opts.humanAuthorizedPriceUsd != null || priceUsd <= this.opts.maxPerTxUsd;
    return withinPolicy && priceUsd <= this.remainingTotal() && priceUsd <= this.availableUsdc;
  }

  /** Why a price is unaffordable, for the skip-ahead log line. */
  reasonUnaffordable(priceUsd: number): string {
    if (this.opts.humanAuthorizedPriceUsd == null && priceUsd - this.opts.maxPerTxUsd > 1e-9) {
      return `price ${fmtUsd(priceUsd)} exceeds the per-transaction limit ${fmtUsd(this.opts.maxPerTxUsd)}`;
    }
    if (priceUsd > this.remainingTotal()) return "cumulative ceiling reached";
    return `insufficient USDC balance (${fmtUsd(this.availableUsdc)})`;
  }

  /** The selector handed to withPaymentInterceptor. Throwing aborts the payment. */
  readonly select = (
    requirements: PaymentRequirements[],
    _network?: unknown,
    _scheme?: unknown,
  ): PaymentRequirements => {
    const req = selectPaymentRequirements(requirements, NETWORK, "exact");
    if (!req) throw new PaymentBlocked("no-acceptable-quote", "server offered no exact/base-sepolia option");

    // 1. Chain and scheme must be the ones we intend to transact on.
    if (req.network !== NETWORK) {
      throw new PaymentBlocked("wrong-network", `quote is on ${req.network}, expected ${NETWORK}`);
    }
    if (req.scheme !== "exact") {
      throw new PaymentBlocked("wrong-scheme", `quote uses scheme ${req.scheme}, expected exact`);
    }

    // 2. Asset identity, checked by address. `asset` is a plain address string
    //    in x402 v1 — reading `asset.decimals` off it always yielded undefined
    //    and silently fell back to assuming 6 decimals, which would misprice
    //    any 18-decimal token by a factor of 10^12.
    let asset: Address;
    try {
      asset = getAddress(req.asset);
    } catch {
      throw new PaymentBlocked("bad-asset", `quote asset is not an address: ${req.asset}`);
    }
    if (asset !== USDC_ADDRESS) {
      throw new PaymentBlocked("wrong-asset", `quote asks for ${asset}, agent only pays USDC ${USDC_ADDRESS}`);
    }

    // 3. Pay only the seller we linked to, when one is configured.
    if (this.opts.expectedPayTo) {
      let payTo: Address;
      try {
        payTo = getAddress(req.payTo);
      } catch {
        throw new PaymentBlocked("bad-payto", `quote payTo is not an address: ${req.payTo}`);
      }
      if (payTo !== this.opts.expectedPayTo) {
        throw new PaymentBlocked("wrong-payee", `quote pays ${payTo}, expected ${this.opts.expectedPayTo}`);
      }
    }

    // 4. Amount must parse to a finite number. Anything else is not payable.
    const atoms = Number(req.maxAmountRequired);
    if (!Number.isFinite(atoms) || atoms < 0) {
      throw new PaymentBlocked("bad-amount", `unparsable maxAmountRequired: ${req.maxAmountRequired}`);
    }
    const usd = atoms / 10 ** USDC_DECIMALS;

    // 5. Balance: do not sign an authorization the wallet cannot cover.
    if (usd > this.availableUsdc + 1e-9) {
      throw new PaymentBlocked(
        "insufficient-balance",
        `price ${fmtUsd(usd)} > USDC balance ${fmtUsd(this.availableUsdc)}`,
      );
    }

    // 6. Price authority. Two different questions depending on who is buying.
    const authorized = this.opts.humanAuthorizedPriceUsd;
    if (authorized != null) {
      // A person clicked Buy at a price they could see. No ceiling applies —
      // but the quote must be the price they agreed to.
      if (Math.abs(usd - authorized) > 1e-9) {
        throw new PaymentBlocked(
          "price-changed",
          `quote is ${fmtUsd(usd)} but you agreed to ${fmtUsd(authorized)} — refusing the difference`,
        );
      }
    } else if (usd - this.opts.maxPerTxUsd > 1e-9) {
      // Unattended spend: the per-transaction limit is the only thing bounding
      // it. Deliberately NOT cumulative — prior spending is irrelevant here.
      throw new PaymentBlocked(
        "over-per-tx-limit",
        `price ${fmtUsd(usd)} > per-transaction limit ${fmtUsd(this.opts.maxPerTxUsd)}`,
      );
    }

    // 7. Optional cumulative ceiling, only when MAX_TOTAL_USD is configured.
    if (this.opts.maxTotalUsd != null && usd - this.remainingTotal() > 1e-9) {
      throw new PaymentBlocked(
        "over-total-limit",
        `price ${fmtUsd(usd)} > ${fmtUsd(this.remainingTotal())} left of the ${fmtUsd(this.opts.maxTotalUsd)} total`,
      );
    }

    this.pending = { usd, task: this.currentTask };
    return req;
  };

  /** Payment settled: append it to the ledger with its tx hash. */
  settled(tx?: string): number {
    if (!this.pending) return 0;
    const { usd, task } = this.pending;
    ledger.record(this.opts.account, { usd, task, status: "settled", tx });
    this.availableUsdc = Math.max(0, this.availableUsdc - usd);
    this.pending = null;
    return usd;
  }

  /**
   * Payment failed. `definitelyUnpaid` means the facilitator rejected it before
   * settlement, so nothing moved and nothing is recorded. An ambiguous failure
   * (timeout after signing) is recorded as `unknown` so it stays visible in the
   * ledger and in any cumulative total.
   */
  failed(definitelyUnpaid: boolean): void {
    if (!this.pending) return;
    if (!definitelyUnpaid) {
      const { usd, task } = this.pending;
      ledger.record(this.opts.account, { usd, task, status: "unknown" });
    }
    this.pending = null;
  }

  /** Surface a PaymentBlocked thrown inside the interceptor. */
  recordBlock(e: unknown): PaymentBlocked | null {
    const blocked = findBlocked(e);
    if (blocked) this.lastBlock = blocked;
    return blocked;
  }

  get blockReason(): PaymentBlocked | null {
    return this.lastBlock;
  }
}

/** Axios wraps interceptor errors, so dig for the original cause. */
export function findBlocked(e: unknown): PaymentBlocked | null {
  let cur: any = e;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof PaymentBlocked) return cur;
    cur = cur.cause ?? cur.error ?? null;
  }
  return null;
}

// Note: a previous `isVerifyRejection` heuristic guessed from the HTTP status
// whether funds had moved. It guessed wrong for settlement-phase failures,
// where a 402 can follow an attempted on-chain send. src/settlement.ts now
// asks USDC directly via authorizationState, which is an exact answer.
