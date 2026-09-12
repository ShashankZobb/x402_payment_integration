import axios, { type AxiosInstance } from "axios";
import { withPaymentInterceptor, decodeXPaymentResponse, createSigner } from "x402-axios";
import { NETWORK, USDC_DECIMALS, agentAccount, fmtUsd, requestTimeoutMs } from "./config.js";
import { isMockMode, mockFailRate, mockTxId } from "./mock.js";
import { PaymentGuard, findBlocked } from "./guard.js";
import {
  authorizationFromError,
  confirmOnChain,
  isTransientSettlementError,
  shortFacilitatorError,
} from "./settlement.js";

/**
 * One paid request, start to finish.
 *
 * Shared by the CLI agent and the dashboard's /api/pay endpoint so both run
 * exactly the same guard, retry and on-chain reconciliation logic. Progress is
 * reported as structured events rather than printed, which lets the CLI format
 * them as log lines and the UI render them as a timeline.
 */

export type PayStep =
  | { step: "quote"; priceUsd: number; ok: boolean; note: string }
  | { step: "check"; ok: boolean; note: string }
  | { step: "pay"; ok: boolean; note: string; txHash?: string; usd?: number }
  | { step: "retry"; attempt: number; of: number; waitMs: number; note: string }
  | { step: "result"; ok: boolean; note: string };

export type PayResult = {
  ok: boolean;
  task: string;
  steps: PayStep[];
  priceUsd: number | null;
  paidUsd: number | null;
  txHash: string | null;
  data: unknown;
  error: string | null;
  /** Set when the guard refused, e.g. "over-per-tx-limit". */
  blockedReason: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_SETTLE_RETRIES = 2;

/** The seller reads `price` off the query string; omit it to use its default. */
function reqParams(
  task: string,
  askPriceUsd?: number | null,
  extra?: Record<string, string>,
): Record<string, string> {
  return { task, ...(extra ?? {}), ...(askPriceUsd == null ? {} : { price: String(askPriceUsd) }) };
}

/** Cheap unpaid look at the price. Convenience only — PaymentGuard.select is
 *  the binding check, running against the requirements actually signed. */
export async function peekPriceUsd(
  serverUrl: string,
  task: string,
  askPriceUsd?: number | null,
  path = "/premium",
  extraParams?: Record<string, string>,
): Promise<number> {
  try {
    const res = await axios.get(`${serverUrl}${path}`, {
      params: reqParams(task, askPriceUsd, extraParams),
      validateStatus: (s) => s === 402 || (s >= 200 && s < 300),
      timeout: 15_000,
    });
    if (res.status !== 402) return 0; // not gated
    const atoms = Number((res.data as any)?.accepts?.[0]?.maxAmountRequired);
    return Number.isFinite(atoms) ? atoms / 10 ** USDC_DECIMALS : Number.NaN;
  } catch {
    return Number.NaN; // unknown → let the guard decide on the real quote
  }
}

/**
 * A payer that runs the real flow but never signs or settles.
 *
 * It still fetches the live 402 and still calls guard.select on those exact
 * requirements, so every enforcement branch is exercised — only the signature
 * and the facilitator are replaced. MOCK_FAIL_RATE injects transient failures
 * so the retry path can be tested deliberately.
 */
function buildMockPayer(guard: PaymentGuard): AxiosInstance {
  const client = axios.create({ timeout: requestTimeoutMs() });
  const get = async (url: string, cfg: any = {}) => {
    const probe = await client.get(url, {
      ...cfg,
      validateStatus: (st: number) => st === 402 || (st >= 200 && st < 300),
    });
    if (probe.status !== 402) return probe;

    // The real guard, against the real quote. Throws exactly as in live mode.
    guard.select((probe.data as any)?.accepts ?? []);

    if (Math.random() < mockFailRate()) {
      const err: any = new Error("replacement transaction underpriced");
      err.response = { status: 402, data: { error: "Details: replacement transaction underpriced" } };
      err.config = cfg;
      throw err;
    }
    return client.get(url, { ...cfg, headers: { ...(cfg.headers ?? {}), "X-MOCK-PAYMENT": mockTxId() } });
  };
  return { get } as unknown as AxiosInstance;
}

export async function buildPayer(guard: PaymentGuard): Promise<AxiosInstance> {
  if (isMockMode()) return buildMockPayer(guard);
  const { privateKey } = agentAccount();
  const signer: any = await (createSigner as any)(NETWORK, privateKey);
  return withPaymentInterceptor(
    axios.create({ timeout: requestTimeoutMs() }) as any,
    signer as any,
    guard.select as any,
  ) as unknown as AxiosInstance;
}

function extractTx(res: any): string | undefined {
  try {
    // Mock settlements carry an obviously-fake id, never a 64-hex hash, so the
    // UI will not turn it into a dead explorer link.
    const mock = res?.headers?.["x-mock-settled"];
    if (mock) return String(mock);
    const h = res?.headers?.["x-payment-response"] ?? res?.headers?.["payment-response"];
    if (!h) return undefined;
    return (decodeXPaymentResponse(h) as any)?.transaction ?? undefined;
  } catch {
    return undefined;
  }
}

export async function payOnce(opts: {
  payer: AxiosInstance;
  guard: PaymentGuard;
  serverUrl: string;
  task: string;
  /** Ask the seller to quote this price instead of its configured default. */
  askPriceUsd?: number | null;
  /** Which paid endpoint to buy from. Defaults to the original single service. */
  path?: string;
  /** Extra query parameters the service needs (from its input schema). */
  params?: Record<string, string>;
  /** Overall budget of time for this call, retries included. */
  timeoutMs?: number;
  onStep?: (s: PayStep) => void;
}): Promise<PayResult> {
  const { payer, guard, serverUrl, task, askPriceUsd, onStep } = opts;
  const path = opts.path ?? "/premium";
  const deadline = Date.now() + (opts.timeoutMs ?? requestTimeoutMs());
  const steps: PayStep[] = [];
  const emit = (s: PayStep) => {
    steps.push(s);
    onStep?.(s);
  };

  guard.beginTask(task);
  const price = await peekPriceUsd(serverUrl, task, askPriceUsd, path, opts.params);
  const priceKnown = Number.isFinite(price);
  emit({
    step: "quote",
    priceUsd: priceKnown ? price : Number.NaN,
    ok: priceKnown,
    note: priceKnown ? `Service asks ${fmtUsd(price)} in USDC on ${NETWORK}` : "Price could not be read from the 402",
  });

  // Skip the payment round trip when the quote is already unaffordable.
  if (priceKnown && !guard.affordable(price)) {
    const why = guard.reasonUnaffordable(price);
    emit({ step: "check", ok: false, note: why });
    emit({ step: "result", ok: false, note: "Blocked before signing — no payment attempted" });
    return {
      ok: false,
      task,
      steps,
      priceUsd: price,
      paidUsd: null,
      txHash: null,
      data: null,
      error: why,
      blockedReason: price > guard.perTxLimit ? "over-per-tx-limit" : "unaffordable",
    };
  }
  emit({
    step: "check",
    ok: true,
    note: `Within the ${fmtUsd(guard.perTxLimit)} per-transaction limit, balance ${fmtUsd(guard.balance)}`,
  });

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await payer.get(`${serverUrl}${path}`, { params: reqParams(task, askPriceUsd, opts.params) });
      const tx = extractTx(res);
      const charged = guard.settled(tx);
      emit({ step: "pay", ok: true, note: `Paid ${fmtUsd(charged)}`, txHash: tx, usd: charged });
      emit({ step: "result", ok: true, note: "Service responded" });
      return {
        ok: true,
        task,
        steps,
        priceUsd: priceKnown ? price : charged,
        paidUsd: charged,
        txHash: tx ?? null,
        data: res.data,
        error: null,
        blockedReason: null,
      };
    } catch (err: any) {
      // 1. The guard refused before anything was signed.
      const refused = findBlocked(err) ?? guard.recordBlock(err);
      if (refused) {
        guard.failed(true);
        emit({ step: "pay", ok: false, note: refused.detail });
        emit({ step: "result", ok: false, note: `Blocked: ${refused.reason}` });
        return {
          ok: false,
          task,
          steps,
          priceUsd: priceKnown ? price : null,
          paidUsd: null,
          txHash: null,
          data: null,
          error: refused.detail,
          blockedReason: refused.reason,
        };
      }

      const raw = err?.response?.data?.error ?? err?.message ?? "";
      const reason = shortFacilitatorError(raw);

      // 2. Ask the chain what actually happened to the authorization we signed.
      const outcome = await confirmOnChain(authorizationFromError(err));

      if (outcome.settled === true) {
        const charged = guard.settled();
        emit({ step: "pay", ok: true, note: `Settled on-chain despite: ${reason}`, usd: charged });
        emit({ step: "result", ok: true, note: "Payment confirmed on-chain" });
        return {
          ok: true,
          task,
          steps,
          priceUsd: priceKnown ? price : charged,
          paidUsd: charged,
          txHash: null,
          data: null,
          error: null,
          blockedReason: null,
        };
      }

      if (outcome.settled === false) {
        guard.failed(true);
        const timeLeft = deadline - Date.now();
        if (isTransientSettlementError(raw) && attempt < MAX_SETTLE_RETRIES && timeLeft > 1200 * (attempt + 1) + 2000) {
          const waitMs = 1200 * (attempt + 1);
          emit({
            step: "retry",
            attempt: attempt + 1,
            of: MAX_SETTLE_RETRIES,
            waitMs,
            note: `${reason} — confirmed unpaid, retrying`,
          });
          await sleep(waitMs);
          guard.beginTask(task);
          continue;
        }
        emit({ step: "pay", ok: false, note: `${reason} — confirmed on-chain that no funds moved` });
        emit({ step: "result", ok: false, note: "Not paid" });
        return {
          ok: false,
          task,
          steps,
          priceUsd: priceKnown ? price : null,
          paidUsd: null,
          txHash: null,
          data: null,
          error: reason,
          blockedReason: null,
        };
      }

      // 3. Could not determine — record it so the spend stays visible.
      guard.failed(false);
      emit({ step: "pay", ok: false, note: `${reason} — could not confirm on-chain` });
      emit({ step: "result", ok: false, note: "Recorded as unconfirmed; verify manually" });
      return {
        ok: false,
        task,
        steps,
        priceUsd: priceKnown ? price : null,
        paidUsd: null,
        txHash: null,
        data: null,
        error: `${reason} (unconfirmed)`,
        blockedReason: null,
      };
    }
  }
}
