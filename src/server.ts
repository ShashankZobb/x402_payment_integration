import "dotenv/config";
import express from "express";
import { paymentMiddleware } from "x402-express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  PER_TX_CEILING_USD,
  MIN_PRICE_USD,
  NETWORK,
  USDC_ADDRESS,
  agentAddressOrNull,
  failClosed,
  envMaxPerTxUsd,
  maxPerTxUsd,
  maxTotalUsd,
  parsePriceInput,
  validatePriceInput,
  requestTimeoutMs,
  payToAddress,
} from "./config.js";
import { setMaxPerTxUsd } from "./settings.js";
import { basescanUrl, basescanTx, getBalances } from "./chain.js";
import { PaymentGuard } from "./guard.js";
import { buildPayer, payOnce } from "./pay.js";
import { MOCK_BANNER, isMockMode, mockStartBalanceUsd, offlineAiReason, useOfflineAi } from "./mock.js";
import { CATALOG, priceString, serviceByPath, serviceById, catalogForAgent } from "./catalog.js";
import { listPurchases, ownedListingKeys, recordPurchase, purchaseCount, totalSpentOnGoods } from "./purchases.js";
import { DEFAULT_TASK_BUDGET_USD, agentModel, runTask } from "./agent-ai.js";
import { runShopping } from "./shop.js";
import { cacheInfo, listingById, loadListings, rankListings, withoutOwned } from "./bazaar.js";
import { buyListing, unbuyableReason } from "./buy-listing.js";
import { bucketTotals, history, spentAllTime, type BucketUnit, type DayTotal } from "./ledger.js";

const PORT = Number(process.env.PORT ?? 4021);
const PRICE = process.env.PRICE_PER_CALL ?? "$0.01";
const FACILITATOR_URL =
  (process.env.FACILITATOR_URL as `https://${string}` | undefined) ??
  ("https://x402.org/facilitator" as `https://${string}`);

let PAY_TO: ReturnType<typeof payToAddress>;
try {
  PAY_TO = payToAddress();
  maxPerTxUsd(); // validate the limit at boot rather than mid-payment
  maxTotalUsd();
} catch (e) {
  failClosed(e);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * Per-boot token for the endpoints that spend money. It is embedded in the
 * dashboard HTML at render time, so same-origin scripts can read it while
 * cross-origin pages cannot (CORS blocks reading the response body).
 */
const RUN_TOKEN = crypto.randomBytes(24).toString("hex");

const app = express();
app.use(express.json());

/**
 * The seller's asking price for one call.
 *
 * Defaults to PRICE_PER_CALL from .env; `?price=` overrides it so the price can
 * be varied per request without restarting the server. Invalid or out-of-range
 * values fall back to the default rather than erroring, because this value ends
 * up inside a 402 quote and a malformed one there is worse than a sane default.
 *
 * Note this makes the CALLER able to name the seller's price, which a real
 * seller would never allow. It is deliberate here: buyer and seller are the same
 * person, and being able to quote an expensive call is what lets you watch the
 * agent's per-transaction limit refuse it.
 */
function priceForRequest(req: express.Request, fallback: string = PRICE): string {
  const asked = parsePriceInput(req.query.price);
  return asked === null ? fallback : `$${asked}`;
}

/**
 * x402 gate for /premium. The middleware is built per request because its
 * routes config takes a fixed Money value, so a per-request price means a
 * per-request middleware. Unpaid requests get 402 + PAYMENT-REQUIRED; a valid
 * payment is verified and settled via the facilitator before next() runs.
 *
 * Only /premium is gated — a liveness probe that charges money would be unusable
 * by any monitor, and /health is what demo.ts polls on startup.
 */
/** x402 gate for one catalog service. Built per request because the route
 *  config takes a fixed Money value and the price can be overridden per call. */
function gateFor(path: string): express.RequestHandler {
  return (req, res, next) => {
    // Mock mode: an unpaid request still gets a genuine 402 (the quote is built
    // locally), but a mock-payment header settles without the facilitator or the
    // chain. Only reachable when the server itself was started in mock mode.
    const mockTx = isMockMode() ? req.get("x-mock-payment") : null;
    if (mockTx) {
      res.setHeader("X-MOCK-SETTLED", mockTx);
      return next();
    }
    const service = serviceByPath(path);
    const mw = paymentMiddleware(
      PAY_TO,
      {
        [`GET ${path}`]: {
          price: priceForRequest(req, service ? priceString(service) : PRICE),
          network: NETWORK,
          config: {
            description: service?.description ?? "Paid service",
            mimeType: "application/json",
            maxTimeoutSeconds: 120,
            inputSchema: service?.input,
            discoverable: true,
          },
        },
      } as any,
      { url: FACILITATOR_URL } as any,
    );
    return mw(req, res, next);
  };
}

app.get("/free", (_req, res) => {
  res.json({ ok: true, mode: "free", message: "No payment needed here." });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "x402-seller", network: NETWORK, price: PRICE });
});

// Every paid service, mounted from the catalog. The middleware guarantees
// payment was verified and settled before a handler runs.
for (const service of CATALOG) {
  app.get(service.path, gateFor(service.path), (req, res) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) params[k] = String(v);
    res.json({
      ok: true,
      service: service.id,
      task: String(req.query.task ?? service.id),
      network: NETWORK,
      price: priceForRequest(req, priceString(service)),
      payTo: PAY_TO,
      result: service.handler(params),
      note: "Payment verified + settled by facilitator. See PAYMENT-RESPONSE header.",
    });
  });
}

// The catalog as the agent sees it — free, for the dashboard.
app.get("/api/catalog", (_req, res) => {
  res.json({ ok: true, services: catalogForAgent(), payTo: PAY_TO, perTxLimitUsd: maxPerTxUsd() });
});

/** Dashboard, with the spend token injected. Registered before express.static
 *  so the raw file is never served without a token. */
function sendDashboard(_req: express.Request, res: express.Response) {
  const file = path.join(PROJECT_ROOT, "public", "dashboard.html");
  const html = fs.readFileSync(file, "utf8").replace("__RUN_TOKEN__", RUN_TOKEN);
  res.type("html").send(html);
}
app.get("/dashboard", sendDashboard);
app.get("/dashboard.html", sendDashboard);

// JSON quote inspector: reads our own 402 so the UI can show price / network /
// asset / payTo without paying.
app.get("/api/quote", async (req, res) => {
  const task = String(req.query.task ?? "job-1");
  try {
    const ask = parsePriceInput(req.query.price);
    const q = `task=${encodeURIComponent(task)}` + (ask == null ? "" : `&price=${ask}`);
    const r = await fetch(`http://127.0.0.1:${PORT}/premium?${q}`);
    const body = (await r.json().catch(() => ({}))) as any;
    const a = body?.accepts?.[0] ?? {};
    const atoms = Number(a.maxAmountRequired);
    res.json({
      status: r.status,
      task,
      priceAtoms: a.maxAmountRequired ?? null,
      priceUsd: Number.isFinite(atoms) ? atoms / 1e6 : null,
      network: a.network ?? NETWORK,
      asset: a.asset ?? null,
      assetIsUsdc: a.asset ? a.asset.toLowerCase() === USDC_ADDRESS.toLowerCase() : null,
      payTo: a.payTo ?? PAY_TO,
      raw: body,
    });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e?.message ?? String(e) });
  }
});

// Agent config + live spend against the durable cap (no secret key exposed).
app.get("/api/agent", (_req, res) => {
  const address = agentAddressOrNull();
  const perTx = maxPerTxUsd();
  const total = maxTotalUsd();
  const spent = address ? spentAllTime(address) : 0;
  res.json({
    serverUrl: `http://localhost:${PORT}`,
    network: NETWORK,
    pricePerCall: PRICE,
    limitMode: "per-transaction",
    mock: isMockMode(),
    agentModel: agentModel(),
    mockAi: useOfflineAi(),
    offlineAiReason: offlineAiReason(),
    defaultTaskBudgetUsd: DEFAULT_TASK_BUDGET_USD,
    services: CATALOG.length,
    maxPerTxUsd: perTx,
    // Where that number came from, so the dashboard can offer to put it back.
    envDefaultUsd: envMaxPerTxUsd(),
    limitSource: perTx === envMaxPerTxUsd() ? "env" : "override",
    minPriceUsd: MIN_PRICE_USD,
    perTxCeilingUsd: PER_TX_CEILING_USD,
    maxTotalUsd: total, // null = no cumulative cap
    requestTimeoutMs: requestTimeoutMs(),
    spentUsd: spent,
    agentAddress: address,
    fundedHint: "Fund AGENT_ADDRESS with Base Sepolia USDC (no ETH needed), then Run agent.",
  });
});

// Recent payments from the durable ledger.
app.get("/api/ledger", (_req, res) => {
  const address = agentAddressOrNull();
  if (!address) return res.status(400).json({ ok: false, error: "No agent account. Run `npm run wallets`." });
  const total = maxTotalUsd();
  const spent = spentAllTime(address);
  res.json({
    ok: true,
    account: address,
    limitMode: "per-transaction",
    maxPerTxUsd: maxPerTxUsd(),
    maxTotalUsd: total,
    spentUsd: spent,
    remainingTotalUsd: total == null ? null : Math.max(0, total - spent),
    entries: history(address),
  });
});

/**
 * Daily spend for the chart. Empty days come back as zeroes so the time axis
 * stays continuous — skipping them would compress gaps and misstate the shape.
 */
app.get("/api/spending", (req, res) => {
  const address = agentAddressOrNull();
  if (!address) return res.status(400).json({ ok: false, error: "No agent account. Run `npm run wallets`." });
  // Ranges are named, not free-form: each picks both a span and the bucket size
  // that reads well at that span (24 hourly bars, or N daily bars).
  const RANGES: Record<string, { unit: BucketUnit; count: number; label: string }> = {
    "24h": { unit: "hour", count: 24, label: "Last 24 hours" },
    "7d": { unit: "day", count: 7, label: "Last 7 days" },
    "14d": { unit: "day", count: 14, label: "Last 14 days" },
    "30d": { unit: "day", count: 30, label: "Last 30 days" },
  };
  const key = String(req.query.range ?? "14d");
  const range = RANGES[key] ?? RANGES["14d"]!;
  const series: DayTotal[] = bucketTotals(address, range.unit, range.count);
  const total = series.reduce((sum, d) => sum + d.usd, 0);
  const calls = series.reduce((sum, d) => sum + d.count, 0);
  const peak = series.reduce((m, d) => (d.usd > m.usd ? d : m), series[0]);
  res.json({
    ok: true,
    range: key in RANGES ? key : "14d",
    rangeLabel: range.label,
    unit: range.unit,
    series,
    totalUsd: Math.round(total * 1e6) / 1e6,
    calls,
    peakUsd: peak?.usd ?? 0,
    peakDate: peak?.date ?? null,
    bucketsWithSpend: series.filter((d) => d.count > 0).length,
    maxPerTxUsd: maxPerTxUsd(),
  });
});

// Live balance for the funding card (address only, never the key).
app.get("/api/balance", async (_req, res) => {
  try {
    const address = agentAddressOrNull();
    if (!address) {
      return res.status(400).json({ ok: false, error: "No agent account in .env. Run `npm run wallets`." });
    }
    const { eth, usdc, spendable } = await getBalances(address);
    res.json({
      ok: true,
      agentAddress: address,
      eth,
      usdc,
      // Gas for the settlement transaction is paid by the facilitator, which
      // submits the EIP-3009 authorization. USDC alone makes a wallet usable.
      funded: spendable,
      mock: isMockMode(),
      ethRequired: false,
      usdcAddress: USDC_ADDRESS,
      basescan: basescanUrl(address),
    });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/** Reject cross-site callers on anything that spends money. */
function requireRunToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.get("x-run-token");
  if (!token || token.length !== RUN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(RUN_TOKEN))) {
    res.status(403).json({ ok: false, error: "Missing or invalid X-Run-Token. Open /dashboard to get one." });
    return;
  }
  next();
}

/**
 * Make one paid request. POST + a custom header, because this moves real funds:
 * a cross-origin page can forge a GET (or a form POST) but cannot set a custom
 * header without a CORS preflight this server never approves.
 *
 * Runs the same PaymentGuard, retry and on-chain reconciliation as the CLI
 * agent (src/pay.ts), and returns the steps so the UI can show what happened
 * rather than a wall of log text.
 */
app.post("/api/pay", requireRunToken, async (req, res) => {
  const address = agentAddressOrNull();
  if (!address) {
    return res.status(400).json({ ok: false, error: "No agent account in .env. Run `npm run wallets`." });
  }

  const task = String(req.body?.task ?? "job-1").slice(0, 64) || "job-1";

  // What the seller should charge for this call. The agent's own limit is NOT
  // caller-controlled any more — it is policy from .env, so a client cannot
  // raise the ceiling on its own spending.
  const priceInput = validatePriceInput(req.body?.price);
  if (!priceInput.ok && priceInput.reason !== "empty") {
    // `field` lets the UI highlight the offending input rather than just
    // printing the message somewhere generic.
    return res.status(400).json({ ok: false, field: "price", error: priceInput.message });
  }
  const askPriceUsd = priceInput.ok ? priceInput.usd : null;
  const perTx = maxPerTxUsd();

  try {
    const guard = new PaymentGuard({
      account: address,
      maxPerTxUsd: perTx,
      maxTotalUsd: maxTotalUsd(),
      expectedPayTo: PAY_TO,
    });
    await guard.refreshBalance();
    const payer = await buildPayer(guard);
    const result = await payOnce({ payer, guard, serverUrl: `http://127.0.0.1:${PORT}`, task, askPriceUsd, timeoutMs: requestTimeoutMs() });
    res.json({
      ...result,
      perTxLimitUsd: perTx,
      askedPriceUsd: askPriceUsd,
      balanceUsd: guard.balance,
      totalPaidUsd: guard.spent(),
      explorerTx: result.txHash ? basescanTx(result.txHash) : null,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, task, error: e?.message ?? String(e), steps: [] });
  }
});

/**
 * Buy one product from the catalog.
 *
 * The money goes to SERVER_PAYTO — your own seller wallet — through the same
 * PaymentGuard as everything else. What makes this different from /api/pay is
 * what happens after: the delivered data is kept in the purchases store, so the
 * thing you bought is still there to look at later.
 */
app.post("/api/buy", requireRunToken, async (req, res) => {
  const address = agentAddressOrNull();
  if (!address) {
    return res.status(400).json({ ok: false, error: "No agent account in .env. Run `npm run wallets`." });
  }

  const productId = String(req.body?.productId ?? "");
  const service = serviceById(productId);
  if (!service) {
    return res.status(400).json({
      ok: false,
      field: "productId",
      error: `No such product: ${JSON.stringify(productId)}`,
      valid: CATALOG.map((s) => s.id),
    });
  }

  // Only the parameters this product declares — a client cannot smuggle in
  // `price` and talk the seller into charging something else.
  const params: Record<string, string> = {};
  const sent = req.body?.params ?? {};
  if (sent && typeof sent === "object" && !Array.isArray(sent)) {
    for (const key of Object.keys(service.input.properties)) {
      if (sent[key] !== undefined && sent[key] !== null && String(sent[key]).trim() !== "") {
        params[key] = String(sent[key]).slice(0, 200);
      }
    }
  }
  const missing = service.input.required.filter((k) => !(k in params));
  if (missing.length) {
    return res.status(400).json({
      ok: false,
      field: missing[0],
      error: `${service.id} needs ${missing.join(", ")}.`,
    });
  }

  try {
    // A person read the price on the card and clicked Buy, so the
    // per-transaction limit is waived — see GuardOptions.humanAuthorizedPriceUsd.
    // The catalog price becomes binding instead: the seller cannot quote more
    // at checkout than it advertised.
    const guard = new PaymentGuard({
      account: address,
      maxPerTxUsd: maxPerTxUsd(),
      maxTotalUsd: maxTotalUsd(),
      expectedPayTo: PAY_TO,
      humanAuthorizedPriceUsd: service.priceUsd,
    });
    await guard.refreshBalance();
    const payer = await buildPayer(guard);
    const result = await payOnce({
      payer,
      guard,
      serverUrl: `http://127.0.0.1:${PORT}`,
      task: service.id,
      path: service.path,
      params,
    });

    // Only a settled payment produces a purchase. A refusal is reported, not stored.
    let purchase = null;
    if (result.ok) {
      purchase = recordPurchase(address, {
        productId: service.id,
        productName: service.description.split(".")[0]!.slice(0, 80),
        usd: result.paidUsd ?? service.priceUsd,
        params,
        txHash: result.txHash,
        data: (result.data as any)?.result ?? result.data,
      });
    }

    res.json({
      ...result,
      productId: service.id,
      purchase,
      paidTo: PAY_TO,
      balanceUsd: guard.balance,
      perTxLimitUsd: guard.perTxLimit,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, productId, error: e?.message ?? String(e), steps: [] });
  }
});

/**
 * Describe what you want; the model picks matching products from the catalog.
 * Anything under the auto-buy threshold is bought immediately; the rest comes
 * back as a suggestion for a person to authorise.
 */
app.post("/api/shop", requireRunToken, async (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim().slice(0, 1000);
  if (!prompt) {
    return res.status(400).json({ ok: false, field: "prompt", error: "Describe what you are looking for." });
  }
  // A threshold is not a price: zero is meaningful (suggest everything, buy
  // nothing), whereas validatePriceInput rightly rejects a zero *price*.
  const parsed = validatePriceInput(req.body?.autoBuyUnderUsd);
  const thresholdOk = parsed.ok || parsed.reason === "empty" || parsed.reason === "zero";
  if (!thresholdOk) {
    return res.status(400).json({ ok: false, field: "autoBuyUnderUsd", error: parsed.message });
  }
  const autoBuyUnderUsd = parsed.ok ? parsed.usd : 0;

  try {
    const result = await runShopping({ prompt, autoBuyUnderUsd, serverUrl: `http://127.0.0.1:${PORT}` });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ ok: false, prompt, error: e?.message ?? String(e), matches: [] });
  }
});

/**
 * The real x402 marketplace, read from Coinbase's discovery registry.
 * Browsing costs nothing and needs no payment.
 */
app.get("/api/market", async (req, res) => {
  try {
    const all = await loadListings();
    // What you already own is not on sale: the library is where it lives now.
    const addr = agentAddressOrNull();
    const forSale = addr ? withoutOwned(all, ownedListingKeys(addr)) : all;
    const maxRaw = Number(req.query.maxUsd);
    const limit = Math.max(1, Math.min(60, Number(req.query.limit) || 24));
    const matched = rankListings(forSale, {
      q: req.query.q ? String(req.query.q) : undefined,
      network: req.query.network ? String(req.query.network) : undefined,
      maxUsd: Number.isFinite(maxRaw) ? maxRaw : undefined,
      sort: req.query.sort === "price" || req.query.sort === "price-desc" ? req.query.sort : undefined,
    });
    // `matched` is what the filters found, `catalog` the whole registry. The UI
    // shows the first so it never claims 600 hits for a two-word search.
    res.json({
      ok: true,
      total: matched.length,
      catalog: forSale.length,
      owned: all.length - forSale.length,
      items: matched.slice(0, limit),
      cache: cacheInfo(),
    });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: `Could not reach the x402 registry: ${e?.message ?? e}` });
  }
});

/** Force a refetch of the registry, ignoring the cache TTL. */
/**
 * Change the per-transaction limit from the dashboard.
 *
 * Behind the run token like every other endpoint that moves or governs money.
 * Saved to disk, so it survives a reload and applies to the CLI too; sending an
 * empty value clears the override and restores the .env default.
 */
app.post("/api/limit", requireRunToken, (req, res) => {
  const raw = req.body?.maxPerTxUsd;
  const blank = raw === undefined || raw === null || String(raw).trim() === "";
  if (blank) {
    setMaxPerTxUsd(null);
    return res.json({ ok: true, maxPerTxUsd: maxPerTxUsd(), source: "env", envDefaultUsd: envMaxPerTxUsd() });
  }
  const parsed = validatePriceInput(raw);
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, field: "maxPerTxUsd", error: parsed.message });
  }
  try {
    setMaxPerTxUsd(parsed.usd);
  } catch (e: any) {
    return res.status(400).json({ ok: false, field: "maxPerTxUsd", error: e?.message ?? String(e) });
  }
  res.json({ ok: true, maxPerTxUsd: maxPerTxUsd(), source: "override", envDefaultUsd: envMaxPerTxUsd() });
});

app.post("/api/market/refresh", requireRunToken, async (_req, res) => {
  try {
    const items = await loadListings(true);
    res.json({ ok: true, total: items.length, cache: cacheInfo() });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: `Could not reach the x402 registry: ${e?.message ?? e}` });
  }
});

/**
 * Buy a marketplace listing.
 *
 * IMPORTANT, and surfaced in the response as `settledLocally`: this does NOT
 * call the third-party seller. Those sellers speak x402 v2 and the client
 * libraries on npm are still v1, so a real purchase from them is not possible
 * yet. What happens instead is a genuine x402 payment of the listing's price,
 * through your own seller, into your own wallet — and the listing's details are
 * recorded as the purchased product.
 *
 * The money movement is real; the counterparty is you.
 */
app.post("/api/buy-listing", requireRunToken, async (req, res) => {
  const address = agentAddressOrNull();
  if (!address) {
    return res.status(400).json({ ok: false, error: "No agent account in .env. Run `npm run wallets`." });
  }
  const listingId = String(req.body?.listingId ?? "");
  const listing = await listingById(listingId);
  if (!listing) {
    return res.status(400).json({ ok: false, field: "listingId", error: "That listing is no longer in the catalog." });
  }
  const blocked = unbuyableReason(listing);
  if (blocked) return res.status(400).json({ ok: false, field: "listingId", error: blocked });

  try {
    const out = await buyListing({
      account: address,
      listing,
      payTo: PAY_TO,
      serverUrl: `http://127.0.0.1:${PORT}`,
      humanAuthorized: true, // a person clicked Buy at a price they could see
    });
    res.json({
      ok: out.ok,
      listing: out.listing,
      paidUsd: out.paidUsd,
      txHash: out.txHash,
      purchase: out.purchase,
      error: out.error,
      paidTo: PAY_TO,
      settledLocally: true,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, listingId, error: e?.message ?? String(e) });
  }
});

/** Everything this account has bought, newest first, with the delivered data. */
app.get("/api/purchases", (_req, res) => {
  const address = agentAddressOrNull();
  if (!address) return res.status(400).json({ ok: false, error: "No agent account. Run `npm run wallets`." });
  res.json({
    ok: true,
    account: address,
    count: purchaseCount(address),
    totalUsd: totalSpentOnGoods(address),
    items: listPurchases(address),
  });
});

/**
 * Give the agent a task in plain English and let it decide what to buy.
 *
 * Same token gate as /api/pay because this spends money — potentially several
 * times in one call. The task budget is validated and clamped server-side; the
 * per-transaction limit remains policy the client cannot touch at all.
 */
app.post("/api/task", requireRunToken, async (req, res) => {
  const task = String(req.body?.task ?? "").trim().slice(0, 2000);
  if (!task) return res.status(400).json({ ok: false, field: "task", error: "Describe what you want the agent to do." });

  const parsed = validatePriceInput(req.body?.budgetUsd);
  if (!parsed.ok && parsed.reason !== "empty") {
    return res.status(400).json({ ok: false, field: "budgetUsd", error: parsed.message });
  }
  const budgetUsd = Math.min(parsed.ok ? parsed.usd : DEFAULT_TASK_BUDGET_USD, PER_TX_CEILING_USD);

  try {
    const result = await runTask({ task, budgetUsd, serverUrl: `http://127.0.0.1:${PORT}` });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ ok: false, task, error: e?.message ?? String(e), steps: [] });
  }
});

app.use(express.static(path.join(PROJECT_ROOT, "public")));

app.get("/", (_req, res) => {
  res.json({
    service: "ai-payment x402 seller",
    network: NETWORK,
    pricePerCall: PRICE,
    payTo: PAY_TO,
    routes: {
      dashboard: "GET /dashboard (test screen)",
      health: "GET /health (free)",
      free: "GET /free",
      paid: "GET /premium?task=<name>  (requires x402 USDC payment)",
    },
  });
});


app.listen(PORT, () => {
  console.log(`[seller] listening on http://localhost:${PORT}`);
  console.log(`[seller] network=${NETWORK} price=${PRICE} payTo=${PAY_TO}`);
  console.log(`[seller] facilitator=${FACILITATOR_URL}`);
  const total = maxTotalUsd();
  console.log(
    `[seller] agent limit=$${maxPerTxUsd()} per transaction (ceiling $${PER_TX_CEILING_USD})` +
      (total == null ? ", no cumulative cap" : `, cumulative cap $${total}`),
  );
  console.log(`[seller] dashboard: http://localhost:${PORT}/dashboard`);
  if (isMockMode()) {
    console.log(`[seller] *** ${MOCK_BANNER}`);
    console.log(`[seller] *** simulated balance starts at $${mockStartBalanceUsd()}`);
  }
});
