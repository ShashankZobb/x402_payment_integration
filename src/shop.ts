import Anthropic from "@anthropic-ai/sdk";
import { agentAccount, fmtUsd, maxPerTxUsd, payToAddress } from "./config.js";
import { loadListings, searchListings, withoutOwned, type Listing } from "./bazaar.js";
import { buyListing, unbuyableReason } from "./buy-listing.js";
import { ownedListingKeys, type Purchase } from "./purchases.js";
import { agentModel } from "./agent-ai.js";
import { offlineAiReason, useOfflineAi } from "./mock.js";

/**
 * Shopping assistant over the real marketplace.
 *
 * "buy 10 otto ai products" -> find Otto AI's listings, buy the ones under the
 * auto-buy threshold, offer the rest as Buy buttons.
 *
 * Deliberately NOT an agentic loop. Picking which listings match is a single
 * judgement, so it is a single structured call against the cached catalog; the
 * buying that follows is ordinary code. The model decides what is RELEVANT,
 * never what gets PAID FOR.
 */

/** Never act on more than this many items from one request. */
const MAX_QUANTITY = 25;
/** Listings offered to the model — enough to choose from, small enough to be cheap. */
const CANDIDATE_LIMIT = 60;

export type Match = {
  listingId: string;
  name: string;
  provider: string;
  priceUsd: number;
  description: string;
  iconUrl: string | null;
  networkLabel: string;
  reason: string;
  autoBought: boolean;
  purchase: Purchase | null;
  blocked: string | null;
};

export type ShopResult = {
  ok: boolean;
  prompt: string;
  /** How many items were asked for, when the request named a number. */
  requestedQuantity: number | null;
  autoBuyUnderUsd: number;
  requestedAutoBuyUsd: number;
  perTxLimitUsd: number;
  matches: Match[];
  spentUsd: number;
  model: string;
  note: string;
  error: string | null;
};

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    listing_ids: {
      type: "array",
      description: "ids of listings that fit the request, best first. Empty if none fit.",
      items: { type: "string" },
    },
    reason: { type: "string", description: "One short sentence explaining the selection." },
  },
  required: ["listing_ids", "reason"],
  additionalProperties: false,
} as const;

/**
 * Pull a leading quantity out of the request: "buy 10 otto ai products" -> 10.
 * Returns the number and the request with it removed, so it does not pollute
 * the search terms.
 */
export function parseQuantity(prompt: string): { quantity: number | null; rest: string } {
  const m = prompt.match(/\b(\d{1,3})\b/);
  if (!m) return { quantity: null, rest: prompt };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return { quantity: null, rest: prompt };
  return {
    quantity: Math.min(n, MAX_QUANTITY),
    rest: (prompt.slice(0, m.index) + " " + prompt.slice(m.index! + m[1]!.length)).trim(),
  };
}

/** Words that carry no signal; without these, "and" matched everything. */
const STOPWORDS = new Set([
  "and", "the", "for", "with", "any", "all", "you", "your", "this", "that", "from",
  "are", "was", "how", "what", "when", "which", "who", "want", "need", "get", "give",
  "please", "find", "show", "tell", "about", "into", "out", "use", "using", "per",
  "can", "could", "would", "should", "right", "now", "just", "one", "two", "some",
  "like", "more", "most", "than", "then", "there", "their", "they", "them", "have",
  "buy", "purchase", "product", "products", "api", "apis", "service", "services",
]);

/**
 * Offline matcher. Scores a listing by how many request words appear in its
 * name, provider or tags — which is exactly right for "10 otto ai products",
 * where the request is a brand name and a count.
 */
export function keywordRank(listings: Listing[], request: string): Listing[] {
  const words = (request.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
  if (!words.length) return [];
  return listings
    .map((l) => {
      const name = (l.name + " " + l.provider).toLowerCase();
      const tags = l.tags.join(" ").toLowerCase();
      const desc = l.description.toLowerCase();
      // A brand hit in the name is worth far more than an incidental one in prose.
      let score = 0;
      for (const w of words) {
        if (name.includes(w)) score += 5;
        else if (tags.includes(w)) score += 2;
        else if (desc.includes(w)) score += 1;
      }
      return { l, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.l.priceUsd - b.l.priceUsd)
    .map((x) => x.l);
}

async function askClaude(prompt: string, candidates: Listing[], model: string): Promise<string[]> {
  const client = new Anthropic();
  const slim = candidates.map((l) => ({
    id: l.id,
    name: l.name,
    provider: l.provider,
    priceUsd: l.priceUsd,
    description: l.description.slice(0, 180),
    tags: l.tags,
  }));
  const res = await client.messages.create({
    model,
    max_tokens: 1500,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: MATCH_SCHEMA } },
    system:
      "You pick marketplace listings that match a shopper's request. Return only listings that genuinely " +
      "fit, best first, by id. If the request names a provider or brand, prefer that provider's listings. " +
      "If nothing fits, return an empty list rather than padding it.",
    messages: [
      {
        role: "user",
        content: `Listings:\n${JSON.stringify(slim)}\n\nShopper's request: ${prompt}`,
      },
    ],
  } as any);

  const parsed = (res as any).parsed_output;
  if (Array.isArray(parsed?.listing_ids)) return parsed.listing_ids.map(String);
  const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  try {
    const j = JSON.parse(text);
    return Array.isArray(j?.listing_ids) ? j.listing_ids.map(String) : [];
  } catch {
    return [];
  }
}

export async function runShopping(opts: {
  prompt: string;
  autoBuyUnderUsd: number;
  serverUrl: string;
}): Promise<ShopResult> {
  const prompt = opts.prompt.trim();
  const perTx = maxPerTxUsd();
  // Unattended buying never exceeds the agent's own limit, whatever was typed.
  const effective = Math.min(opts.autoBuyUnderUsd, perTx);
  const model = agentModel();
  const { quantity, rest } = parseQuantity(prompt);

  const base = {
    prompt,
    requestedQuantity: quantity,
    autoBuyUnderUsd: effective,
    requestedAutoBuyUsd: opts.autoBuyUnderUsd,
    perTxLimitUsd: perTx,
    model: useOfflineAi() ? "keyword-match" : model,
  };

  const { address } = agentAccount();

  let all: Listing[];
  try {
    all = await loadListings(); // cached, 5-minute TTL
  } catch (e: any) {
    return { ...base, ok: false, matches: [], spentUsd: 0, note: "", error: `Could not load the catalog: ${e?.message ?? e}` };
  }

  // Anything already in the library is removed before the model ever sees it,
  // so "buy 10 Otto AI products" cannot spend money re-buying what you own.
  // Enforced here, in code, rather than asked for in the prompt.
  const catalogSize = all.length;
  all = withoutOwned(all, ownedListingKeys(address));
  const skippedOwned = catalogSize - all.length;

  // Rank offline first. This is the whole answer in mock mode, and in live mode
  // it narrows 600 listings to a shortlist so the model call stays cheap.
  const ranked = keywordRank(all, rest || prompt);

  let chosen: Listing[];
  if (useOfflineAi()) {
    // No key, or MOCK_AI set: rank by keyword instead of refusing to work.
    chosen = ranked;
  } else {
    const candidates = (ranked.length ? ranked : searchListings(all, { limit: CANDIDATE_LIMIT })).slice(0, CANDIDATE_LIMIT);
    try {
      const ids = await askClaude(prompt, candidates, model);
      const byId = new Map(candidates.map((l) => [l.id, l]));
      chosen = ids.map((id) => byId.get(id)).filter((l): l is Listing => !!l);
    } catch (e: any) {
      const msg =
        e instanceof Anthropic.AuthenticationError
          ? "ANTHROPIC_API_KEY was rejected."
          : e instanceof Anthropic.APIError
            ? `Claude API error ${e.status}: ${e.message}`
            : (e?.message ?? String(e));
      return { ...base, ok: false, matches: [], spentUsd: 0, note: "", error: msg };
    }
  }

  if (!chosen.length) {
    return {
      ...base,
      ok: true,
      matches: [],
      spentUsd: 0,
      note: skippedOwned
        ? `Nothing left in the catalog matched that — ${skippedOwned} matching item${skippedOwned === 1 ? " is" : "s are"} already in your library.`
        : "Nothing in the catalog matched that. Try a provider name, or search the Marketplace directly.",
      error: null,
    };
  }

  // A quantity caps how many DISTINCT listings are acted on. Nothing is ever
  // bought twice to pad a count, and asking for more than exist buys only what
  // exists.
  const wanted = quantity ?? chosen.length;
  const picked = chosen.slice(0, wanted);

  const payTo = payToAddress();
  const matches: Match[] = [];
  let spent = 0;

  for (const listing of picked) {
    const match: Match = {
      listingId: listing.id,
      name: listing.name,
      provider: listing.provider,
      priceUsd: listing.priceUsd,
      description: listing.description,
      iconUrl: listing.iconUrl,
      networkLabel: listing.networkLabel,
      reason: quantity ? `Matches "${rest || prompt}".` : "Matches your request.",
      autoBought: false,
      purchase: null,
      blocked: unbuyableReason(listing),
    };

    if (!match.blocked && listing.priceUsd < effective) {
      const out = await buyListing({
        account: address,
        listing,
        payTo,
        serverUrl: opts.serverUrl,
        humanAuthorized: false, // unattended: the per-transaction limit applies
      });
      if (out.ok) {
        spent = Math.round((spent + (out.paidUsd ?? 0)) * 1e6) / 1e6;
        match.autoBought = true;
        match.purchase = out.purchase;
      } else {
        match.blocked = out.error;
      }
    }
    matches.push(match);
  }

  const bought = matches.filter((m) => m.autoBought).length;
  const shortfall = quantity != null && chosen.length < quantity;
  const note =
    (quantity != null
      ? `Asked for ${quantity}; ${shortfall ? `only ${chosen.length} match` : `showing ${picked.length}`}. `
      : "") +
    `${bought} bought automatically (${fmtUsd(spent)}), ${matches.length - bought} left for you to approve. ` +
    (skippedOwned ? `${skippedOwned} already in your library were skipped. ` : "") +
    (effective < opts.autoBuyUnderUsd ? `Auto-buy capped at ${fmtUsd(effective)} by the per-transaction limit.` : "");

  return { ...base, ok: true, matches, spentUsd: spent, note: note.trim(), error: null };
}
