import crypto from "node:crypto";

/**
 * The real x402 marketplace, read from Coinbase's public discovery registry.
 *
 * This module is READ-ONLY and involves no payment. It supplies the product
 * list — genuine names, descriptions and prices from ~14,500 live x402
 * services — which the dashboard shows instead of invented ones.
 *
 * Buying is deliberately NOT done against these sellers. They speak x402 v2
 * (requirements in a PAYMENT-REQUIRED header, CAIP-2 networks, `amount`), and
 * the client libraries on npm are still v1. So a purchase here charges the
 * listing's price through your OWN seller and records the listing's details;
 * see /api/buy-listing in src/server.ts, which says so plainly.
 */

const DISCOVERY = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
/** Pages of 100. Enough for a browsable catalog without a slow cold start. */
const PAGES = 6;
/** Listings go stale after this; a Refresh button forces an early refetch. */
const TTL_MS = 5 * 60 * 1000;

export type Listing = {
  /** Stable id derived from the resource URL, so a Buy survives a refetch. */
  id: string;
  /** The seller's own product name where given (88% of listings). */
  name: string;
  /** Host, shown as the vendor. */
  provider: string;
  url: string;
  description: string;
  priceUsd: number;
  /** What the registry actually quoted, before tamePrice() brought it under $5. */
  rawPriceUsd: number;
  network: string;
  /** "Base Sepolia" etc., for display. */
  networkLabel: string;
  tags: string[];
  /** Product image where the seller supplies one (~28%). */
  iconUrl: string | null;
  updatedAt: string | null;
};

let cache: { at: number; items: Listing[] } | null = null;
let inFlight: Promise<Listing[]> | null = null;

const NETWORK_LABELS: Record<string, string> = {
  "eip155:8453": "Base",
  "eip155:84532": "Base Sepolia",
  "eip155:1": "Ethereum",
  "eip155:137": "Polygon",
  "eip155:42161": "Arbitrum",
  "eip155:56": "BNB Chain",
  "eip155:43114": "Avalanche",
};

function labelFor(network: string): string {
  if (NETWORK_LABELS[network]) return NETWORK_LABELS[network]!;
  if (network.startsWith("solana:")) return "Solana";
  if (network.startsWith("xrpl:")) return "XRPL";
  return network;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

/** Fallback name when the seller supplies none: host + last path segment. */
function nameFrom(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter((p) => p && !p.startsWith(":") && !/^v\d+$/i.test(p));
    const tail = segs.slice(-2).join("/");
    const host = u.hostname.replace(/^www\./, "");
    return (tail ? `${host}/${tail}` : host).slice(0, 70);
  } catch {
    return url.slice(0, 70);
  }
}

function idFor(url: string, network: string): string {
  return crypto.createHash("sha1").update(`${url}|${network}`).digest("hex").slice(0, 12);
}

/**
 * Read a listing's price in dollars.
 *
 * The registry is not uniform: some sellers quote `amount` in atoms ("1000")
 * and others in whole token units ("0.0001"), and the field is named
 * `maxAmountRequired` on v1 entries and `amount` on v2.
 *
 * The magnitude tells them apart. A value above 1 is atoms, so divide by 1e6.
 * A value of 1 or below is quoted in token units and is divided by 1000.
 * Whatever the asset, the result is taken to be dollars — every stablecoin in
 * the registry is dollar-denominated, so this holds in practice.
 *
 * The boundary is a deliberate trade: a literal 1-atom price ($0.000001) reads
 * as $0.001. That is vanishingly rare next to genuine listings, and the
 * alternative — assuming atoms everywhere — showed every sub-cent listing as $0.
 */
function priceOf(accept: any): number {
  const raw = accept?.amount ?? accept?.maxAmountRequired;
  const n = Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return Number.NaN;
  return n > 1 ? n / 1e6 : n / 1000;
}

/**
 * Bring a listing's price under $5 so it is payable in this demo.
 *
 * Real listings go up to hundreds of dollars, which no demo wallet should be
 * asked to settle. Rather than hide them, their price is reduced by a fixed,
 * deterministic rule so the same listing always costs the same thing:
 *
 *   - $5 or less                  unchanged
 *   - over $5 but under $10       halved            ($7.50 -> $3.75)
 *   - $10 or more                 its first non-zero digit   ($42 -> $4, $100 -> $1)
 *                                 halved again if that is still over $5 ($99 -> $9 -> $4.50)
 *
 * The untouched quote is kept on the listing as rawPriceUsd, so what the seller
 * actually asks is never lost.
 */
export function tamePrice(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 5) return usd;
  let out: number;
  if (usd < 10) {
    out = usd / 2;
  } else {
    const digit = Math.trunc(usd).toString().split("").find((c) => c !== "0");
    out = Number(digit ?? "1");
    if (out > 5) out = out / 2;
  }
  return Math.round(out * 1e6) / 1e6;
}

function normalize(items: any[]): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const url = String(it?.resource ?? "");
    if (!url) continue;
    const accepts = Array.isArray(it?.accepts) ? it.accepts : [];
    // One entry per resource: take the cheapest payable option it offers.
    let best: { price: number; network: string } | null = null;
    for (const a of accepts) {
      const price = priceOf(a);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (!best || price < best.price) best = { price, network: String(a?.network ?? "unknown") };
    }
    if (!best) continue;
    const id = idFor(url, best.network);
    if (seen.has(id)) continue;
    seen.add(id);
    const icon = typeof it?.iconUrl === "string" && /^https:\/\//.test(it.iconUrl) ? it.iconUrl : null;
    out.push({
      id,
      // The seller's own name reads far better than one derived from the URL.
      name: String(it?.serviceName ?? "").trim() || nameFrom(url),
      provider: hostOf(url),
      url,
      description: String(it?.description ?? "").trim(),
      priceUsd: tamePrice(Math.round(best.price * 1e6) / 1e6),
      rawPriceUsd: Math.round(best.price * 1e6) / 1e6,
      network: best.network,
      networkLabel: labelFor(best.network),
      tags: Array.isArray(it?.tags) ? it.tags.slice(0, 5).map(String) : [],
      iconUrl: icon,
      updatedAt: typeof it?.lastUpdated === "string" ? it.lastUpdated : null,
    });
  }
  // A serviceName is often a brand shared by many endpoints ("Otto AI" x10),
  // which makes a list of them unreadable. Where a name repeats, append the
  // distinguishing part of the path so each product is identifiable.
  const counts = new Map<string, number>();
  for (const l of out) counts.set(l.name, (counts.get(l.name) ?? 0) + 1);
  for (const l of out) {
    if ((counts.get(l.name) ?? 0) < 2) continue;
    try {
      const segs = new URL(l.url).pathname.split("/").filter((x) => x && !x.startsWith(":"));
      const tail = segs.slice(-2).join("/");
      if (tail) l.name = `${l.name} · ${tail}`.slice(0, 80);
    } catch {
      /* leave the name as it is */
    }
  }
  return out;
}

async function fetchPage(offset: number): Promise<any[]> {
  const res = await fetch(`${DISCOVERY}?limit=100&offset=${offset}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`discovery returned ${res.status}`);
  const j = (await res.json()) as any;
  return Array.isArray(j?.items) ? j.items : [];
}

/** Cached listings. Concurrent callers share one fetch. */
export async function loadListings(force = false): Promise<Listing[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.items;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const pages = await Promise.all(
      Array.from({ length: PAGES }, (_, i) => fetchPage(i * 100).catch(() => [] as any[])),
    );
    const items = normalize(pages.flat());
    // A partial result still beats an empty catalog; only replace on success.
    if (items.length) cache = { at: Date.now(), items };
    return cache?.items ?? [];
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** How presentable a listing is: drives the default "Featured" ordering. */
function completeness(l: Listing): number {
  let score = 0;
  if (l.iconUrl) score += 4;
  if (l.tags.length) score += 2 + Math.min(l.tags.length, 3);
  // A seller-supplied name, as opposed to one derived from the URL.
  if (!l.name.includes("/") || l.name !== nameFrom(l.url)) score += 3;
  if (l.description.length > 60) score += 2;
  return score;
}

export type SearchOpts = {
  q?: string;
  network?: string;
  maxUsd?: number;
  limit?: number;
  sort?: "price" | "price-desc";
};

/**
 * Everything that matches, in display order and NOT truncated.
 *
 * Split out from searchListings so a caller can report how many listings a
 * search actually found. Reporting `all.length` instead told the shopper
 * "600 listings matching weather" no matter what they typed.
 */
export function rankListings(all: Listing[], opts: SearchOpts = {}): Listing[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const words = q ? q.split(/\s+/).filter(Boolean) : [];
  let out = all;
  if (opts.network) out = out.filter((l) => l.network === opts.network);
  if (opts.maxUsd != null) out = out.filter((l) => l.priceUsd <= opts.maxUsd!);
  if (words.length) {
    out = out
      .map((l) => {
        const hay = `${l.name} ${l.provider} ${l.description} ${l.tags.join(" ")}`.toLowerCase();
        return { l, score: words.filter((w) => hay.includes(w)).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.l.priceUsd - b.l.priceUsd)
      .map((x) => x.l);
    // An explicit sort still applies to what the search found. Without this,
    // choosing "Cheapest" alongside a query silently did nothing.
    if (opts.sort === "price") out = [...out].sort((a, b) => a.priceUsd - b.priceUsd);
    else if (opts.sort === "price-desc") out = [...out].sort((a, b) => b.priceUsd - a.priceUsd);
  } else if (opts.sort === "price") {
    out = [...out].sort((a, b) => a.priceUsd - b.priceUsd);
  } else if (opts.sort === "price-desc") {
    out = [...out].sort((a, b) => b.priceUsd - a.priceUsd);
  } else {
    // Featured: best-presented first. Registry order is not neutral — its first
    // pages are dominated by one provider whose entries carry no name, icon or
    // tags, so an unsorted page showed the least presentable listings the
    // catalog has. Rank by how complete a listing is instead.
    out = [...out].sort((a, b) => completeness(b) - completeness(a));
  }
  return out;
}

/**
 * Drop listings already in the library.
 *
 * A product you own is not for sale again: it disappears from the shop, and the
 * assistant never sees it, so unattended buying cannot re-buy it either.
 */
export function withoutOwned(all: Listing[], owned: Set<string>): Listing[] {
  if (!owned.size) return all;
  return all.filter((l) => !owned.has(l.id) && !owned.has(l.name.toLowerCase()));
}

/** The page of results to show: rankListings, truncated to `limit`. */
export function searchListings(all: Listing[], opts: SearchOpts = {}): Listing[] {
  return rankListings(all, opts).slice(0, opts.limit ?? 24);
}

export async function listingById(id: string): Promise<Listing | undefined> {
  return (await loadListings()).find((l) => l.id === id);
}

export function cacheInfo(): { cached: number; ageMs: number | null; ttlMs: number } {
  return {
    cached: cache?.items.length ?? 0,
    ageMs: cache ? Date.now() - cache.at : null,
    ttlMs: TTL_MS,
  };
}
