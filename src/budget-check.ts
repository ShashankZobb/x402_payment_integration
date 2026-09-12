import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Address } from "viem";
import {
  PER_TX_CEILING_USD,
  ConfigError,
  USDC_ADDRESS,
  envMaxPerTxUsd,
  maxPerTxUsd,
  parseBudgetInput,
  validatePriceInput,
  requireFiniteNumber,
  sellerAccount,
  hasSellerKey,
} from "./config.js";
import { tamePrice, withoutOwned } from "./bazaar.js";
import { setMaxPerTxUsd } from "./settings.js";
import { listPurchases, ownedListingKeys, purchaseCount, purchasesPath, purgePurchases, recordPurchase } from "./purchases.js";
import { wouldStrandFunds } from "./env-file.js";
import { CATALOG, catalogForAgent, priceString, serviceById, serviceByPath } from "./catalog.js";
import { TaskBudget } from "./agent-ai.js";
import { PaymentGuard, PaymentBlocked } from "./guard.js";
import * as ledger from "./ledger.js";

/**
 * Guard regression suite. Runs offline — no chain, no server, no funds.
 * Every case here is a bug that was previously live.
 *
 * The old version of this file hardcoded `expect 3 paid + 1 blocked`, which
 * was only true for one specific price/budget pair; it threw a spurious
 * failure as soon as .env changed. Expectations are now derived.
 */

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Build payment requirements the way the seller would. */
function quote(usd: number, over: Partial<Record<string, unknown>> = {}) {
  return [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: String(Math.round(usd * 1e6)),
      asset: USDC_ADDRESS,
      payTo: "0x000000000000000000000000000000000000dEaD",
      resource: "http://localhost:4021/premium",
      description: "test",
      mimeType: "application/json",
      maxTimeoutSeconds: 120,
      ...over,
    },
  ] as any;
}

function expectBlocked(guard: PaymentGuard, reqs: any, reason: string, label: string) {
  try {
    guard.select(reqs);
    check(label, false, "payment was allowed");
  } catch (e) {
    const blocked = e instanceof PaymentBlocked ? e : null;
    check(label, blocked?.reason === reason, blocked ? `got ${blocked.reason}` : String(e));
  }
}

// --- 1. Malformed limits must fail closed, not become NaN ------------------
// `Number("abc")` is NaN and `price - NaN > 1e-9` is false, so a junk budget
// used to disable the cap entirely and authorize unlimited spending.
console.log("\nconfig validation (NaN must not disarm the cap)");
for (const bad of ["abc", "NaN", "Infinity", "-1", "1e400"]) {
  let threw = false;
  try {
    requireFiniteNumber("MAX_PER_TX_USD", bad, 0.05);
  } catch (e) {
    threw = e instanceof ConfigError;
  }
  check(`rejects MAX_PER_TX_USD=${bad}`, threw);
}
check("accepts a valid limit", requireFiniteNumber("MAX_PER_TX_USD", "0.25", 0.05) === 0.25);
check("falls back when unset", requireFiniteNumber("MAX_PER_TX_USD", undefined, 0.05) === 0.05);

// --- 2. Untrusted limit input from the dashboard ---------------------------
console.log("\nuntrusted limit input");
check("rejects junk string", parseBudgetInput("abc") === null);
check("rejects repeated query param (array)", parseBudgetInput(["1", "2"]) === null);
check("rejects negative", parseBudgetInput("-5") === null);
check("clamps to ceiling", parseBudgetInput("9999") === PER_TX_CEILING_USD);
check("passes a sane value", parseBudgetInput("0.25") === 0.25);

// --- 2b. Price input reports WHY it was rejected ---------------------------
console.log("\nprice input validation");
{
  const cases: Array<[unknown, string]> = [
    ["abc", "not-a-number"],
    ["12abc", "not-a-number"],
    [["1", "2"], "not-a-number"],
    ["-1", "negative"],
    ["-0.5", "negative"],
    ["0", "zero"],
    ["0.00001", "too-small"],
    ["", "empty"],
  ];
  for (const [input, want] of cases) {
    const r = validatePriceInput(input);
    const got = r.ok ? "ok" : r.reason;
    check(`${JSON.stringify(input)} -> ${want}`, got === want, `got ${got}`);
  }
  // Every rejection must carry a message a person can act on.
  for (const bad of ["abc", "-1", "0", "0.00001"]) {
    const r = validatePriceInput(bad);
    check(`${JSON.stringify(bad)} has a useful message`, !r.ok && r.message.length > 15 && /\.$/.test(r.message));
  }
  const neg = validatePriceInput("-1");
  check("negative message says so", !neg.ok && /negative/i.test(neg.message));
  const nan = validatePriceInput("abc");
  check("not-a-number message asks for a number", !nan.ok && /number/i.test(nan.message));

  // Valid forms, including the friendly ones.
  // A large amount is no longer rejected here: PaymentGuard refuses anything
  // over the per-transaction limit at signing time, which is the check that
  // actually protects the wallet.
  for (const [input, want] of [["0.01", 0.01], ["$0.25", 0.25], ["1,000", 1000] as const] as Array<[string, number]>) {
    const r = validatePriceInput(input);
    check(`${input} -> ${want}`, r.ok && r.usd === want, r.ok ? String(r.usd) : (r as any).reason);
  }
}

// --- 2c. Seller wallet must be recoverable --------------------------------
// The original code generated a seller keypair, kept the address and discarded
// the key, so every payment landed somewhere unspendable.
console.log("\nseller account (earnings must be recoverable)");
{
  const saved = { key: process.env.SERVER_PRIVATE_KEY, payTo: process.env.SERVER_PAYTO };
  const k = generatePrivateKey();
  const addr = privateKeyToAccount(k).address;

  process.env.SERVER_PRIVATE_KEY = k;
  process.env.SERVER_PAYTO = addr;
  let ok = false;
  try {
    ok = sellerAccount().address === addr;
  } catch (e) {
    check("accepts a matching key + payTo", false, String(e));
  }
  if (ok) check("accepts a matching key + payTo", true);
  check("hasSellerKey() true when recoverable", hasSellerKey());

  // A payTo that does not belong to the key means income goes somewhere we
  // cannot spend from — exactly the original bug, so it must fail loudly.
  process.env.SERVER_PAYTO = privateKeyToAccount(generatePrivateKey()).address;
  let threw: unknown = null;
  try {
    sellerAccount();
  } catch (e) {
    threw = e;
  }
  check("rejects payTo that does not match the key", threw instanceof ConfigError);
  check("hasSellerKey() false on mismatch", !hasSellerKey());

  for (const bad of [undefined, "", "not-a-key", "0x1234"]) {
    if (bad === undefined) delete process.env.SERVER_PRIVATE_KEY;
    else process.env.SERVER_PRIVATE_KEY = bad;
    process.env.SERVER_PAYTO = addr;
    let t = false;
    try {
      sellerAccount();
    } catch (e) {
      t = e instanceof ConfigError;
    }
    check(`fails closed on key=${JSON.stringify(bad)}`, t);
  }

  if (saved.key === undefined) delete process.env.SERVER_PRIVATE_KEY;
  else process.env.SERVER_PRIVATE_KEY = saved.key;
  if (saved.payTo === undefined) delete process.env.SERVER_PAYTO;
  else process.env.SERVER_PAYTO = saved.payTo;
}

// --- 2d. Rotation must not silently orphan funds ---------------------------
console.log("\nrotation guard");
{
  const funded = [{ label: "SELLER", address: "0xabc", usdc: 2.45 }];
  const empty = [{ label: "SELLER", address: "0xabc", usdc: 0 }];
  check("blocks when a wallet still holds USDC", wouldStrandFunds(funded, false).blocked);
  check("names what is at risk", wouldStrandFunds(funded, false).atRisk[0]?.usdc === 2.45);
  check("allows when --force is given", !wouldStrandFunds(funded, true).blocked);
  check("allows when balances are zero", !wouldStrandFunds(empty, false).blocked);
  check("allows when there is nothing to check", !wouldStrandFunds([], false).blocked);
}

// --- 2e. The catalog the agent sees must match what the seller charges -----
// If these could drift, the model would reason about one price while the
// middleware quoted another — and the guard would refuse purchases the agent
// believed were affordable.
console.log("");
console.log("catalog integrity");
{
  check("catalog is not empty", CATALOG.length > 0);
  check("ids are unique", new Set(CATALOG.map((s) => s.id)).size === CATALOG.length);
  check("paths are unique", new Set(CATALOG.map((s) => s.path)).size === CATALOG.length);

  for (const svc of CATALOG) {
    check(`${svc.id}: price is a positive finite number`, Number.isFinite(svc.priceUsd) && svc.priceUsd > 0);
    // priceString feeds the x402 route config; it must round-trip exactly.
    check(`${svc.id}: priceString round-trips`, Number(priceString(svc).slice(1)) === svc.priceUsd, priceString(svc));
    check(`${svc.id}: lookup by id and path agree`, serviceById(svc.id) === svc && serviceByPath(svc.path) === svc);
    check(`${svc.id}: has a description the agent can choose from`, svc.description.length > 30);
    // Tool schemas must be strict-shaped or the SDK rejects them.
    check(`${svc.id}: schema is a strict object`, svc.input.type === "object" && svc.input.additionalProperties === false);
    check(`${svc.id}: every required key is declared`, svc.input.required.every((k) => k in svc.input.properties));
    // The handler must survive whatever the model sends.
    let ran = false;
    try {
      const sample: Record<string, string> = {};
      for (const k of svc.input.required) sample[k] = "ETH/USDC";
      ran = svc.handler(sample) != null;
    } catch (e) {
      check(`${svc.id}: handler runs`, false, String(e));
    }
    if (ran) check(`${svc.id}: handler runs`, true);
    check(`${svc.id}: handler tolerates empty params`, (() => { try { return svc.handler({}) != null; } catch { return false; } })());
  }

  // The agent view must not leak internals, and must keep prices intact.
  const view = catalogForAgent();
  check("agent view covers every service", view.length === CATALOG.length);
  check("agent view hides paths and handlers", view.every((v) => !("path" in v) && !("handler" in v)));
  check(
    "agent view prices match the catalog",
    view.every((v) => serviceById(v.id)!.priceUsd === v.priceUsd),
  );

  // The refusal path must be reachable, or the guard demo is hypothetical.
  const overLimit = CATALOG.filter((s) => s.priceUsd > 0.05);
  check("at least one service exceeds the default $0.05 per-tx limit", overLimit.length > 0,
    overLimit.map((s) => s.id).join(",") || "none");
  check("at least one service is affordable under it", CATALOG.some((s) => s.priceUsd <= 0.05));
}

// --- 2e2. Marketplace price rule + owned filter -----------------------------
// Registry prices reach four figures. tamePrice brings every listing under $5
// deterministically, so the same listing always costs the same thing.
console.log("");
console.log("the per-call cap is adjustable at runtime");
{
  // The dashboard writes an override; every code path must pick it up, because
  // they all ask maxPerTxUsd() rather than reading the env themselves.
  const envValue = envMaxPerTxUsd();
  check("with no override, the limit is the .env default", maxPerTxUsd() === envValue, String(maxPerTxUsd()));

  setMaxPerTxUsd(0.25);
  check("an override takes effect immediately", maxPerTxUsd() === 0.25, String(maxPerTxUsd()));
  check("the .env default is still reported separately", envMaxPerTxUsd() === envValue);

  setMaxPerTxUsd(1.5);
  check("it can be raised again", maxPerTxUsd() === 1.5, String(maxPerTxUsd()));

  // The guard must refuse a quote above the NEW limit, not the old one.
  const g = new PaymentGuard({
    account: "0x0000000000000000000000000000000000000001",
    maxPerTxUsd: maxPerTxUsd(),
    maxTotalUsd: null,
  });
  check("the guard is built from the live limit", (g as any).opts.maxPerTxUsd === 1.5);

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let threw = false;
    try { setMaxPerTxUsd(bad); } catch { threw = true; }
    check(`refuses to save ${String(bad)} as a limit`, threw);
  }
  check("a refused save leaves the limit untouched", maxPerTxUsd() === 1.5, String(maxPerTxUsd()));

  setMaxPerTxUsd(null);
  check("clearing the override restores the .env default", maxPerTxUsd() === envValue, String(maxPerTxUsd()));
}

console.log("");
console.log("marketplace price rule");
{
  const cases: Array<[number, number]> = [
    [0.001, 0.001],   // untouched
    [4.99, 4.99],     // untouched
    [5, 5],           // the boundary is inclusive: 5 is not "more than 5"
    [6, 3],           // single digit over 5 -> halved
    [7.5, 3.75],
    [9.99, 4.995],
    [10, 1],          // two digits -> first non-zero digit
    [42, 4],
    [99, 4.5],        // 9 is still over 5, so halved again
    [100, 1],
    [1234, 1],
    [2000, 2],
  ];
  for (const [input, want] of cases) {
    const got = tamePrice(input);
    check(`$${input} -> $${want}`, got === want, `got ${got}`);
  }
  check("every result is at or under $5", cases.every(([inp]) => tamePrice(inp) <= 5));
  check("is deterministic", tamePrice(4217) === tamePrice(4217));
  check("leaves a non-finite value alone rather than inventing a price", Number.isNaN(tamePrice(Number.NaN)));
}

console.log("");
console.log("owning something outlives its record");
{
  // The records are capped; the knowledge that you own the item must not be.
  // Without this, an evicted purchase reappeared in the shop and could be
  // bought a second time.
  const acct = privateKeyToAccount(generatePrivateKey()).address;
  purgePurchases(acct);
  const first = { id: "first-listing-id", name: "First Thing" };
  recordPurchase(acct, {
    productId: first.name,
    productName: "the one that gets evicted",
    usd: 0.001,
    params: {},
    txHash: null,
    data: { listing: { id: first.id } },
  });
  // Push it out of the retained window.
  for (let i = 0; i < 205; i++) {
    recordPurchase(acct, {
      productId: `filler-${i}`,
      productName: "filler",
      usd: 0.001,
      params: {},
      txHash: null,
      data: { listing: { id: `filler-id-${i}` } },
    });
  }
  check("records are capped", purchaseCount(acct) === 200, String(purchaseCount(acct)));
  check("the evicted purchase is no longer listed",
    !listPurchases(acct, 200).some((x) => x.productId === first.name));
  const keys = ownedListingKeys(acct);
  check("but it is still known to be owned (by id)", keys.has(first.id));
  check("and by name", keys.has(first.name.toLowerCase()));
  const shelf = [{ id: first.id, name: first.name }, { id: "other", name: "Other" }] as any;
  check("so it stays out of the shop", withoutOwned(shelf, keys).map((l: any) => l.id).join(",") === "other");
  purgePurchases(acct);
  check("purging clears the owned keys too", ownedListingKeys(acct).size === 0);
}

console.log("");
console.log("a store written before the owned list is backfilled");
{
  // Records made before the owned list existed must be protected by the first
  // write that follows, or the next eviction still forgets them.
  const acct = privateKeyToAccount(generatePrivateKey()).address;
  purgePurchases(acct);
  const old = {
    productId: "Legacy Thing",
    productName: "bought before the owned list existed",
    usd: 0.001,
    params: {},
    txHash: null,
    data: { listing: { id: "legacy-id" } },
  };
  recordPurchase(acct, old);
  // Simulate the pre-change file: records present, no owned list.
  const raw = JSON.parse(readFileSync(purchasesPath(), "utf8"));
  delete raw.owned[acct.toLowerCase()];
  writeFileSync(purchasesPath(), JSON.stringify(raw, null, 2));
  check("owned list really is absent", !JSON.parse(readFileSync(purchasesPath(), "utf8")).owned[acct.toLowerCase()]);
  // Any later purchase backfills it.
  recordPurchase(acct, { ...old, productId: "Something Else", data: { listing: { id: "other-id" } } });
  const after = JSON.parse(readFileSync(purchasesPath(), "utf8")).owned[acct.toLowerCase()] ?? [];
  check("the older purchase was backfilled", after.includes("legacy-id"), after.join(","));
  purgePurchases(acct);
}

console.log("");
console.log("owned listings are not for sale");
{
  const mk = (id: string, name: string) => ({ id, name, priceUsd: 0.01 }) as any;
  const all = [mk("aaa", "Otto AI"), mk("bbb", "Bitrefill"), mk("ccc", "Vibe Springs")];
  check("nothing owned leaves the catalog alone", withoutOwned(all, new Set()).length === 3);
  check("an owned id is removed", withoutOwned(all, new Set(["bbb"])).map((l) => l.id).join(",") === "aaa,ccc");
  // Purchases made before the listing id was stored match on name instead.
  check("an owned name is removed too", withoutOwned(all, new Set(["otto ai"])).map((l) => l.id).join(",") === "bbb,ccc");
  check("owning everything empties the shop", withoutOwned(all, new Set(["aaa", "bbb", "ccc"])).length === 0);
}

// --- 2f. Per-task budget ---------------------------------------------------
// Layered on top of the per-transaction limit: the guard bounds one payment,
// this bounds a whole task, which is what matters once an agent can buy in a
// loop.
console.log("");
console.log("task budget");
{
  const b = new TaskBudget(0.05);
  check("starts with the full amount", b.remaining === 0.05);
  check("affords a purchase within it", b.affords(0.02));
  b.record(0.02);
  check("tracks spend", b.spent === 0.02 && b.remaining === 0.03);
  check("affords exactly the remainder", b.affords(0.03));
  check("refuses a cent more than the remainder", !b.affords(0.04));
  b.record(0.03);
  check("exhausts cleanly to zero", b.remaining === 0 && b.spent === 0.05);
  check("refuses anything once exhausted", !b.affords(0.005));
  check("never reports negative remaining", new TaskBudget(0.01).remaining >= 0);

  // Float drift would silently let an agent overspend by fractions of a cent.
  const drift = new TaskBudget(0.1);
  for (let i = 0; i < 10; i++) drift.record(0.01);
  check("no float drift after ten purchases", drift.spent === 0.1 && drift.remaining === 0, String(drift.spent));
}

// --- 2g. The dashboard's inline script must parse -------------------------
// A stray brace here breaks the WHOLE page silently: no function is defined,
// every panel sits on its placeholder, and the server looks broken when it is
// fine. That shipped once. Compiling the script (without running it) catches it.
console.log("");
console.log("dashboard script");
{
  const html = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
  const open = html.lastIndexOf("<script>");
  const close = html.lastIndexOf("</script>");
  check("dashboard has an inline script", open !== -1 && close > open);
  if (open !== -1 && close > open) {
    const js = html.slice(open + "<script>".length, close).replace("__RUN_TOKEN__", "test");
    let err: string | null = null;
    try {
      // Compiles and throws on a syntax error; never executes the body.
      new Function(js);
    } catch (e: any) {
      err = e?.message ?? String(e);
    }
    check("inline script parses", err === null, err ?? "");
  }
}

// --- 3. Quote validation at signing time -----------------------------------
console.log("\nquote validation");
const testAccount: Address = privateKeyToAccount(generatePrivateKey()).address;
const PRICE = 0.01;
const SELLER = "0x000000000000000000000000000000000000dEaD" as Address;

{
  const guard = new PaymentGuard({
    account: testAccount,
    maxPerTxUsd: 1,
    initialBalanceUsd: 10,
    expectedPayTo: SELLER,
  });
  guard.beginTask("validate");
  expectBlocked(guard, quote(PRICE, { network: "base" }), "wrong-network", "refuses a different chain");
  expectBlocked(
    guard,
    quote(PRICE, { asset: "0x1111111111111111111111111111111111111111" }),
    "wrong-asset",
    "refuses a non-USDC asset",
  );
  expectBlocked(guard, quote(PRICE, { maxAmountRequired: "not-a-number" }), "bad-amount", "refuses an unparsable amount");
  expectBlocked(
    guard,
    quote(PRICE, { payTo: "0x0000000000000000000000000000000000000001" }),
    "wrong-payee",
    "refuses an unexpected payee",
  );
}

// --- 3b. Human-authorised purchases ---------------------------------------
// The per-transaction limit bounds an AGENT spending unattended. A person who
// read the price and clicked Buy is the authorisation, so the limit is waived —
// but the quote must then equal what they were shown.
console.log("");
console.log("human-authorised purchase");
{
  const LIMIT = 0.05;
  const LISTED = 0.1; // deliberately above the limit

  const human = new PaymentGuard({
    account: testAccount,
    maxPerTxUsd: LIMIT,
    initialBalanceUsd: 10,
    expectedPayTo: SELLER,
    humanAuthorizedPriceUsd: LISTED,
  });
  human.beginTask("manual");
  let allowed = false;
  try {
    human.select(quote(LISTED));
    human.failed(true); // do not record; this is a guard test, not a purchase
    allowed = true;
  } catch (e) {
    check("allows an over-limit price the person agreed to", false, String(e));
  }
  if (allowed) check("allows an over-limit price the person agreed to", true);
  check("reports itself as human-authorised", human.isHumanAuthorized);
  check("affordable() ignores the limit when authorised", human.affordable(LISTED));

  // Bait and switch: advertised one price, quoted another at checkout.
  const switched = new PaymentGuard({
    account: testAccount,
    maxPerTxUsd: LIMIT,
    initialBalanceUsd: 10,
    expectedPayTo: SELLER,
    humanAuthorizedPriceUsd: LISTED,
  });
  switched.beginTask("switched");
  expectBlocked(switched, quote(LISTED + 0.02), "price-changed", "refuses a quote above the listed price");

  const cheaper = new PaymentGuard({
    account: testAccount,
    maxPerTxUsd: LIMIT,
    initialBalanceUsd: 10,
    expectedPayTo: SELLER,
    humanAuthorizedPriceUsd: LISTED,
  });
  cheaper.beginTask("cheaper");
  // Even a cheaper quote is a mismatch: it means the listing was wrong.
  expectBlocked(cheaper, quote(LISTED - 0.02), "price-changed", "refuses a quote below the listed price");

  // Balance still binds: waiving the limit is not waiving solvency.
  const broke = new PaymentGuard({
    account: testAccount,
    maxPerTxUsd: LIMIT,
    initialBalanceUsd: 0.01,
    expectedPayTo: SELLER,
    humanAuthorizedPriceUsd: LISTED,
  });
  broke.beginTask("broke");
  expectBlocked(broke, quote(LISTED), "insufficient-balance", "still refuses what the wallet cannot cover");

  // And the agent path is untouched: no authorisation means the limit applies.
  const agent = new PaymentGuard({
    account: testAccount,
    maxPerTxUsd: LIMIT,
    initialBalanceUsd: 10,
    expectedPayTo: SELLER,
  });
  agent.beginTask("agent");
  expectBlocked(agent, quote(LISTED), "over-per-tx-limit", "unattended spend is still capped by the limit");
  check("agent guard is not human-authorised", !agent.isHumanAuthorized);
}

// --- 3c. Auto-buy threshold is capped by the limit -------------------------
console.log("");
console.log("auto-buy threshold");
{
  const perTx = 0.05;
  const effective = (asked: number) => Math.min(asked, perTx);
  check("a lower threshold governs", effective(0.02) === 0.02);
  check("a higher threshold is capped by the limit", effective(0.2) === perTx);
  check("zero means suggest everything, buy nothing", effective(0) === 0);
  // "less than" is strict: a product priced exactly at the threshold is offered,
  // not bought, which is what "auto-buy under X" should mean.
  check("a product priced exactly at the threshold is not auto-bought", !(0.02 < effective(0.02)));
  check("a product below the threshold is auto-bought", 0.01 < effective(0.02));
}

// --- 4. Balance must be checked before signing -----------------------------
console.log("\nbalance enforcement");
{
  const broke = new PaymentGuard({ account: testAccount, maxPerTxUsd: 100, initialBalanceUsd: 0 });
  broke.beginTask("nofunds");
  expectBlocked(broke, quote(PRICE), "insufficient-balance", "refuses to sign with no USDC");
}

// --- 5. The per-transaction limit ------------------------------------------
console.log("\nper-transaction limit");
{
  ledger.purge(testAccount);
  const limit = 0.05;
  const guard = new PaymentGuard({ account: testAccount, maxPerTxUsd: limit, initialBalanceUsd: 10 });

  guard.beginTask("at-the-limit");
  let ok = true;
  try {
    guard.select(quote(limit)); // exactly at the limit must be allowed
    guard.settled("0xexact");
  } catch (e) {
    ok = false;
    check("allows a payment exactly at the limit", false, String(e));
  }
  if (ok) check("allows a payment exactly at the limit", true);

  guard.beginTask("over-the-limit");
  expectBlocked(guard, quote(limit + 0.01), "over-per-tx-limit", "blocks a payment above the limit");

  // The limit is NOT cumulative: many payments under it are all fine, no
  // matter how much has already been spent.
  let paid = 0;
  for (let i = 0; i < 20; i++) {
    const g = new PaymentGuard({ account: testAccount, maxPerTxUsd: limit, initialBalanceUsd: 10 });
    g.beginTask(`tx-${i}`);
    try {
      g.select(quote(PRICE));
      g.settled(`0xtest${i}`);
      paid++;
    } catch (e) {
      check(`unexpected block on attempt ${i}`, false, String(e));
    }
  }
  check("20 under-limit payments all pass (limit is per-tx, not a total)", paid === 20, `paid=${paid}`);
  check(
    "ledger still records the running total for visibility",
    Math.abs(ledger.spentAllTime(testAccount) - (limit + paid * PRICE)) < 1e-9,
    `total=${ledger.spentAllTime(testAccount)}`,
  );
}

// --- 6. The OPTIONAL cumulative ceiling ------------------------------------
console.log("\noptional cumulative ceiling (off unless MAX_TOTAL_USD is set)");
{
  const account: Address = privateKeyToAccount(generatePrivateKey()).address;
  const total = PRICE * 2;
  let paid = 0;
  let stopped = 0;
  for (let i = 0; i < 4; i++) {
    const g = new PaymentGuard({ account, maxPerTxUsd: 1, maxTotalUsd: total, initialBalanceUsd: 10 });
    g.beginTask(`tx-${i}`);
    try {
      g.select(quote(PRICE));
      g.settled(`0xtotal${i}`);
      paid++;
    } catch (e) {
      if (e instanceof PaymentBlocked && e.reason === "over-total-limit") stopped++;
      else check(`unexpected error on attempt ${i}`, false, String(e));
    }
  }
  check("stops once the cumulative ceiling is reached", paid === 2 && stopped === 2, `paid=${paid} stopped=${stopped}`);
  ledger.purge(account);
}

// --- 7. Ledger records outcomes, not attempts ------------------------------
console.log("\nledger records");
{
  const account: Address = privateKeyToAccount(generatePrivateKey()).address;
  const g = new PaymentGuard({ account, maxPerTxUsd: 1, initialBalanceUsd: 10 });
  g.beginTask("rejected");
  g.select(quote(PRICE));
  g.failed(true); // rejected before settlement: nothing moved, nothing recorded
  check("a rejected payment is not recorded", ledger.spentAllTime(account) === 0);

  g.beginTask("ambiguous");
  g.select(quote(PRICE));
  g.failed(false); // outcome unknown: recorded so it stays visible
  check("an unconfirmed payment is recorded", Math.abs(ledger.spentAllTime(account) - PRICE) < 1e-9);
  check("and is flagged unknown", ledger.history(account)[0]?.status === "unknown");
  ledger.purge(account);
}

ledger.purge(testAccount);

console.log("");
if (failures > 0) {
  console.error(`GUARD-FAILED: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("GUARD-OK: limit, balance and quote validation all enforced before any signature");
