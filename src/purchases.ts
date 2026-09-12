import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { isMockMode } from "./mock.js";

/**
 * The goods, as opposed to the money.
 *
 * .spend-ledger.json records payments — amounts, tx hashes, outcomes — and is
 * the file the spending chart and the optional total cap read. This store keeps
 * what those payments actually BOUGHT: the product, the parameters asked for,
 * and the data the service returned.
 *
 * Kept separate deliberately. The ledger is a financial record with careful
 * commit semantics and gets read on every chart refresh; stuffing full API
 * responses into it would bloat that path and blur two different jobs. A
 * purchase here is only ever written after money actually moved.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const STORE_PATH = path.join(PROJECT_ROOT, isMockMode() ? ".purchases.mock.json" : ".purchases.json");
const LOCK_PATH = STORE_PATH + ".lock";

export type Purchase = {
  id: string;
  ts: string;
  /** Catalog id, e.g. "sentiment". */
  productId: string;
  productName: string;
  usd: number;
  /** What was asked for — the same params round-trip back into a re-buy. */
  params: Record<string, string>;
  txHash: string | null;
  /** What the service actually delivered. The point of this store. */
  data: unknown;
};

type StoreFile = {
  version: 1;
  accounts: Record<string, Purchase[]>;
  /**
   * Keys of everything ever bought, per account, kept SEPARATELY from the
   * records above and never trimmed with them.
   *
   * A Purchase carries a full API payload, so the records have to be capped.
   * But dropping the oldest record used to also forget that the item was owned,
   * which put it back on sale and let it be bought a second time. These keys are
   * a few bytes each, so they outlive the records that created them.
   */
  owned?: Record<string, string[]>;
};
const EMPTY: StoreFile = { version: 1, accounts: {}, owned: {} };

/** Cap on retained goods per account, so the file cannot grow without bound. */
const MAX_KEPT = 200;
/** Far higher: these are short strings, not payloads. */
const MAX_OWNED_KEYS = 10_000;

function readRaw(): StoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as StoreFile;
    if (parsed?.version !== 1 || typeof parsed.accounts !== "object") return { ...EMPTY };
    return parsed;
  } catch {
    return { ...EMPTY }; // missing or corrupt: start clean rather than throw
  }
}

function writeRaw(data: StoreFile): void {
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_PATH); // atomic replace, never a half-written file
}

/** Same mkdir lock as the ledger: atomic on every platform. */
function withLock<T>(fn: (d: StoreFile) => { data: StoreFile; result: T }): T {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_PATH);
      break;
    } catch {
      if (Date.now() > deadline) {
        try {
          fs.rmdirSync(LOCK_PATH);
        } catch {
          /* another process won the race */
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const { data, result } = fn(readRaw());
    writeRaw(data);
    return result;
  } finally {
    try {
      fs.rmdirSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  }
}

function forAccount(d: StoreFile, account: Address): Purchase[] {
  return d.accounts[account.toLowerCase()] ?? [];
}

/** How one purchase is recognised later: its listing id, and its product name. */
function keysOf(p: Pick<Purchase, "productId" | "data">): string[] {
  const out: string[] = [];
  const id = (p.data as { listing?: { id?: unknown } } | null | undefined)?.listing?.id;
  if (typeof id === "string" && id) out.push(id);
  if (p.productId) out.push(p.productId.toLowerCase());
  return out;
}

/** Record a delivered product. Call only after the payment settled. */
export function recordPurchase(
  account: Address,
  p: Omit<Purchase, "id" | "ts">,
): Purchase {
  return withLock((data) => {
    const entry: Purchase = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      ...p,
    };
    const acct = account.toLowerCase();
    const prior = forAccount(data, account);
    // Remember the item is owned even after its record is eventually evicted.
    const owned = new Set(data.owned?.[acct] ?? []);
    // One-time backfill for a store written before this list existed: seed it
    // from the records still held, before the next trim can drop any of them.
    if (!data.owned?.[acct]) for (const p of prior) for (const k of keysOf(p)) owned.add(k);
    for (const k of keysOf(entry)) owned.add(k);
    data.accounts[acct] = [...prior, entry].slice(-MAX_KEPT);
    data.owned = { ...(data.owned ?? {}), [acct]: [...owned].slice(-MAX_OWNED_KEYS) };
    return { data, result: entry };
  });
}

/** Newest first. */
export function listPurchases(account: Address, limit = 50): Purchase[] {
  return forAccount(readRaw(), account).slice(-limit).reverse();
}

export function getPurchase(account: Address, id: string): Purchase | undefined {
  return forAccount(readRaw(), account).find((p) => p.id === id);
}

/**
 * Everything already owned, as keys a listing can be matched against: the
 * listing id where it was recorded, plus the lower-cased product name.
 *
 * The name is the fallback for purchases made before the id was stored, and it
 * also catches the same product re-listed under a fresh id after a registry
 * refetch. Used to keep owned items out of the shop, and out of the reach of
 * unattended buying.
 */
export function ownedListingKeys(account: Address): Set<string> {
  const data = readRaw();
  const out = new Set<string>(data.owned?.[account.toLowerCase()] ?? []);
  // Also scan the retained records, so a store written before the owned list
  // existed still hides what it holds.
  for (const p of forAccount(data, account)) for (const k of keysOf(p)) out.add(k);
  return out;
}

export function purchaseCount(account: Address): number {
  return forAccount(readRaw(), account).length;
}

export function totalSpentOnGoods(account: Address): number {
  const t = forAccount(readRaw(), account).reduce((s, p) => s + p.usd, 0);
  return Math.round(t * 1e6) / 1e6;
}

export function purchasesPath(): string {
  return STORE_PATH;
}

/** Used by tests to clean up after themselves. */
export function purgePurchases(account: Address): void {
  withLock((data) => {
    delete data.accounts[account.toLowerCase()];
    if (data.owned) delete data.owned[account.toLowerCase()];
    return { data, result: undefined };
  });
}
