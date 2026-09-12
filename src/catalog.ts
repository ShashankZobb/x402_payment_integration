/**
 * The services this seller offers, defined once.
 *
 * This array is the single source for three things that must never disagree:
 *   1. the x402 paymentMiddleware route config (path -> price)
 *   2. the Express handlers that do the work
 *   3. the catalog the AI agent sees when choosing what to buy
 *
 * If they could drift, the agent could be told $0.01 while the seller charges
 * $0.10 — so they are derived, not duplicated, and a test asserts it.
 *
 * Handlers are deterministic and offline, like the original /premium: the point
 * of the project is the payment rail, not the data.
 */

export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required: string[];
  additionalProperties: false;
};

export type Service = {
  id: string;
  /** HTTP path; also the key the payment middleware gates. */
  path: string;
  priceUsd: number;
  /** Written for the agent — it decides from this text alone. */
  description: string;
  input: JsonSchema;
  handler: (params: Record<string, string>) => unknown;
};

/** Deterministic pseudo-random in [0,1) from a string, so results are stable. */
function seeded(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

const SYMBOLS = ["BASE/USDC", "ETH/USDC", "BTC/USDC", "SOL/USDC"];

export const CATALOG: Service[] = [
  {
    id: "fx-rate",
    path: "/api/fx",
    priceUsd: 0.005,
    description:
      "Cheapest option. Returns the current exchange rate for one trading pair. " +
      "Use when you only need a price, not analysis.",
    input: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Trading pair, e.g. ETH/USDC" },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    handler: ({ symbol }) => {
      const s = (symbol || "ETH/USDC").toUpperCase();
      const base = { "BASE/USDC": 1.02, "ETH/USDC": 3120, "BTC/USDC": 64500, "SOL/USDC": 148 }[s] ?? 100;
      return { symbol: s, rate: Number((base * (0.98 + seeded(s) * 0.04)).toFixed(4)), asOf: new Date().toISOString() };
    },
  },
  {
    id: "market-signal",
    // Unchanged path: the original single-endpoint demo still works as it did.
    path: "/premium",
    priceUsd: 0.01,
    description:
      "Trading signals across the major pairs with a confidence score for each. " +
      "Good general-purpose starting point for a market question.",
    input: {
      type: "object",
      properties: {
        task: { type: "string", description: "A label for this lookup, e.g. market-signal" },
      },
      required: ["task"],
      additionalProperties: false,
    },
    handler: ({ task }) => {
      const signals = [
        { symbol: "BASE/USDC", signal: "accumulate", confidence: 0.82 },
        { symbol: "ETH/USDC", signal: "hold", confidence: 0.64 },
        { symbol: "BTC/USDC", signal: "take-profit", confidence: 0.71 },
      ];
      return {
        task: task ?? "market-signal",
        generatedAt: new Date().toISOString(),
        signals,
        summary: `Task '${task ?? "market-signal"}': 3 signals computed. Top pick ${signals[0]!.symbol} (${signals[0]!.signal}, ${signals[0]!.confidence}).`,
      };
    },
  },
  {
    id: "sentiment",
    path: "/api/sentiment",
    priceUsd: 0.02,
    description:
      "Social and news sentiment for one asset: a score from -1 (very bearish) to " +
      "+1 (very bullish), volume of mentions, and the dominant themes.",
    input: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Asset or pair, e.g. ETH/USDC" },
        window: { type: "string", description: "Lookback window", enum: ["1h", "24h", "7d"] },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    handler: ({ symbol, window }) => {
      const s = (symbol || "ETH/USDC").toUpperCase();
      const w = window || "24h";
      const r = seeded(s + w);
      const score = Number((r * 2 - 1).toFixed(2));
      return {
        symbol: s,
        window: w,
        score,
        mood: score > 0.25 ? "bullish" : score < -0.25 ? "bearish" : "mixed",
        mentions: 500 + Math.floor(r * 9500),
        themes: ["staking yields", "L2 fees", "ETF flows"].slice(0, 2 + Math.floor(r * 2)),
      };
    },
  },
  {
    id: "deep-report",
    path: "/api/deep-report",
    // Deliberately above the default $0.05 per-transaction limit, so the guard
    // refusing a purchase is reachable on demand rather than hypothetical.
    priceUsd: 0.1,
    description:
      "Full multi-asset research report: signals, sentiment, correlations and a " +
      "written outlook. Expensive — the most thorough option available.",
    input: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What the report should cover" },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    handler: ({ topic }) => ({
      topic: topic ?? "market overview",
      generatedAt: new Date().toISOString(),
      sections: SYMBOLS.map((sym) => ({
        symbol: sym,
        outlook: ["constructive", "neutral", "cautious"][Math.floor(seeded(sym + topic) * 3)],
        confidence: Number((0.5 + seeded(sym) * 0.45).toFixed(2)),
      })),
      note: "Synthetic demo data.",
    }),
  },
];

export function serviceById(id: string): Service | undefined {
  return CATALOG.find((s) => s.id === id);
}

export function serviceByPath(path: string): Service | undefined {
  return CATALOG.find((s) => s.path === path);
}

/** x402 Money string for a service, e.g. "$0.005". */
export function priceString(s: Service): string {
  return `$${s.priceUsd}`;
}

/** What the agent is shown. Deliberately excludes handlers and paths — the
 *  agent selects by id, and the server maps id -> path. */
export function catalogForAgent(): Array<{ id: string; priceUsd: number; description: string; input: JsonSchema }> {
  return CATALOG.map(({ id, priceUsd, description, input }) => ({ id, priceUsd, description, input }));
}
