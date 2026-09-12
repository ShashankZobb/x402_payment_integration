import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Settings a person can change while the server is running.
 *
 * Only the per-transaction limit lives here so far. It used to be readable only
 * from MAX_PER_TX_USD in .env, which meant changing the agent's spending policy
 * required editing a file and restarting; the dashboard could show the number
 * but not set it.
 *
 * This file is the override; .env remains the default. Writing it changes the
 * limit for EVERY path at once — the Buy button, the assistant's unattended
 * buying, the direct call and the CLI — because they all ask config.ts for the
 * limit and config.ts asks here first. There is deliberately no second copy of
 * the number for the UI to drift from.
 *
 * NOTE ON IMPORTS: this module must not import mock.ts, which imports config.ts,
 * which imports this. It reads MOCK_PAYMENTS itself instead.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function mockMode(): boolean {
  const v = (process.env.MOCK_PAYMENTS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function storePath(): string {
  return path.join(PROJECT_ROOT, mockMode() ? ".settings.mock.json" : ".settings.json");
}

export type Settings = {
  version: 1;
  /** Overrides MAX_PER_TX_USD when set. Absent means "use the .env default". */
  maxPerTxUsd?: number;
};

const EMPTY: Settings = { version: 1 };

/**
 * Cached so the guard does not stat the disk on every price check. Invalidated
 * by our own writes; a file edited by hand needs a restart, which is the same
 * deal as .env.
 */
let cached: Settings | null = null;

export function readSettings(): Settings {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as Settings;
    cached = parsed?.version === 1 ? parsed : { ...EMPTY };
  } catch {
    cached = { ...EMPTY }; // missing or corrupt: fall back to the .env default
  }
  return cached;
}

function write(next: Settings): void {
  const target = storePath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, target); // atomic replace, never a half-written file
  cached = next;
}

/**
 * Set the per-transaction limit, or clear it back to the .env default.
 *
 * The caller validates the number; a non-finite or non-positive value is
 * refused here too rather than trusted, because this value is the thing that
 * stands between a runaway agent and the wallet.
 */
export function setMaxPerTxUsd(usd: number | null): Settings {
  const current = readSettings();
  if (usd === null) {
    const { maxPerTxUsd: _drop, ...rest } = current;
    const next = { ...rest, version: 1 } as Settings;
    write(next);
    return next;
  }
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`per-transaction limit must be a positive number, got ${usd}`);
  }
  const next: Settings = { ...current, version: 1, maxPerTxUsd: Math.round(usd * 1e6) / 1e6 };
  write(next);
  return next;
}

export function settingsPath(): string {
  return storePath();
}

/** Used by tests, and by anything that changes MOCK_PAYMENTS mid-process. */
export function resetSettingsCache(): void {
  cached = null;
}
