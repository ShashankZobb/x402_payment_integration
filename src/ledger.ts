import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { isMockMode } from "./mock.js";

/**
 * Durable payment record, keyed by agent address.
 *
 * The enforced limit is per-transaction (see src/guard.ts), so this file is a
 * history rather than a gate: it answers "what has this account paid, and for
 * what", and backs the optional MAX_TOTAL_USD ceiling when one is configured.
 *
 * Writes go through an atomic mkdir lock so concurrent agent processes cannot
 * clobber each other's entries.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
/**
 * Mock runs get their own file. Simulated spending must never mix into real
 * spending history, or the chart and totals silently become fiction.
 */
const LEDGER_PATH = path.join(PROJECT_ROOT, isMockMode() ? ".spend-ledger.mock.json" : ".spend-ledger.json");
const LOCK_PATH = LEDGER_PATH + ".lock";

export type BudgetWindow = "daily" | "monthly" | "forever";

export type Entry = {
  id: string;
  ts: string;
  usd: number;
  task: string;
  /** `unknown` = signed but the outcome was never confirmed; counted, not proven. */
  status: "settled" | "unknown";
  tx?: string;
};

type LedgerFile = { version: 1; accounts: Record<string, Entry[]> };

const EMPTY: LedgerFile = { version: 1, accounts: {} };

export function budgetWindow(): BudgetWindow {
  const w = (process.env.BUDGET_WINDOW ?? "daily").toLowerCase();
  return w === "monthly" || w === "forever" ? w : "daily";
}

/** Window key for a timestamp: entries outside the current key don't count. */
function windowKey(d: Date, w: BudgetWindow): string {
  if (w === "forever") return "all";
  const iso = d.toISOString();
  return w === "monthly" ? iso.slice(0, 7) : iso.slice(0, 10);
}

function readFileRaw(): LedgerFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) as LedgerFile;
    if (parsed?.version !== 1 || typeof parsed.accounts !== "object") return { ...EMPTY };
    return parsed;
  } catch {
    return { ...EMPTY }; // missing or corrupt → start clean
  }
}

function writeFileRaw(data: LedgerFile): void {
  const tmp = `${LEDGER_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, LEDGER_PATH); // atomic replace, never a half-written ledger
}

/** mkdir is atomic on every platform, which makes it a usable cross-process lock. */
function withLock<T>(fn: (data: LedgerFile) => { data: LedgerFile; result: T }): T {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_PATH);
      break;
    } catch {
      if (Date.now() > deadline) {
        // Stale lock from a killed process — clear it rather than deadlock.
        try {
          fs.rmdirSync(LOCK_PATH);
        } catch {
          /* another process won the race; retry */
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // 25ms sync backoff
    }
  }
  try {
    const { data, result } = fn(readFileRaw());
    writeFileRaw(data);
    return result;
  } finally {
    try {
      fs.rmdirSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  }
}

function entriesFor(data: LedgerFile, account: Address): Entry[] {
  return data.accounts[account.toLowerCase()] ?? [];
}

/** Total ever paid from this account. Backs the optional MAX_TOTAL_USD ceiling. */
export function spentAllTime(account: Address): number {
  return entriesFor(readFileRaw(), account).reduce((sum, e) => sum + e.usd, 0);
}

/** Total paid inside the current window. Reporting only. */
export function spentInWindow(account: Address, w: BudgetWindow = budgetWindow()): number {
  const key = windowKey(new Date(), w);
  return entriesFor(readFileRaw(), account)
    .filter((e) => windowKey(new Date(e.ts), w) === key)
    .reduce((sum, e) => sum + e.usd, 0);
}

export type BucketUnit = "hour" | "day";
export type DayTotal = { date: string; usd: number; count: number };

/** Bucket key for a timestamp: "2026-09-12T14" hourly, "2026-09-12" daily. */
function bucketKey(iso: string, unit: BucketUnit): string {
  return unit === "hour" ? iso.slice(0, 13) : iso.slice(0, 10);
}

/**
 * Spend per bucket over the last `count` hours or days, oldest first.
 *
 * Empty buckets are included as zeroes: a time axis that silently skips them
 * compresses gaps and misstates the shape of the series.
 */
export function bucketTotals(account: Address, unit: BucketUnit, count: number): DayTotal[] {
  const span = Math.max(1, Math.min(unit === "hour" ? 168 : 365, Math.floor(count)));
  const buckets = new Map<string, DayTotal>();
  const now = new Date();
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now);
    if (unit === "hour") d.setUTCHours(d.getUTCHours() - i);
    else d.setUTCDate(d.getUTCDate() - i);
    const key = bucketKey(d.toISOString(), unit);
    buckets.set(key, { date: key, usd: 0, count: 0 });
  }
  for (const e of entriesFor(readFileRaw(), account)) {
    const b = buckets.get(bucketKey(e.ts, unit));
    if (!b) continue; // outside the window
    b.usd += e.usd;
    b.count += 1;
  }
  // Float addition drifts; round to USDC's 6 decimals so 0.01*3 is 0.03.
  return [...buckets.values()].map((b) => ({ ...b, usd: Math.round(b.usd * 1e6) / 1e6 }));
}

/** Append one payment. Called after the outcome is known, never before. */
export function record(
  account: Address,
  p: { usd: number; task: string; status: Entry["status"]; tx?: string },
): Entry {
  return withLock((data) => {
    const entry: Entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      usd: p.usd,
      task: p.task,
      status: p.status,
      ...(p.tx ? { tx: p.tx } : {}),
    };
    data.accounts[account.toLowerCase()] = [...entriesFor(data, account), entry];
    return { data, result: entry };
  });
}

export function history(account: Address, limit = 20): Entry[] {
  return entriesFor(readFileRaw(), account).slice(-limit).reverse();
}

export function ledgerPath(): string {
  return LEDGER_PATH;
}

/** Drop every entry for an account. Used by budget-check to clean up after itself. */
export function purge(account: Address): void {
  withLock((data) => {
    delete data.accounts[account.toLowerCase()];
    return { data, result: undefined };
  });
}
