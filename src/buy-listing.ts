import type { Address } from "viem";
import { MIN_PRICE_USD, maxPerTxUsd, maxTotalUsd } from "./config.js";
import { PaymentGuard } from "./guard.js";
import { buildPayer, payOnce } from "./pay.js";
import { recordPurchase, type Purchase } from "./purchases.js";
import type { Listing } from "./bazaar.js";

/**
 * Buy one marketplace listing.
 *
 * Shared by the Buy button (/api/buy-listing) and the shopping assistant, so a
 * purchase means exactly the same thing however it was triggered.
 *
 * The money movement is real; the counterparty is you. The third-party seller
 * is not called — they speak x402 v2 and the client libraries are still v1 —
 * so this charges the listing's price through your own seller and records the
 * listing as the product bought.
 */

export type BuyOutcome = {
  ok: boolean;
  listing: Listing;
  paidUsd: number | null;
  txHash: string | null;
  purchase: Purchase | null;
  error: string | null;
};

/** Why a listing cannot be charged locally, or null when it can. */
export function unbuyableReason(listing: Listing): string | null {
  if (listing.priceUsd < MIN_PRICE_USD) {
    return (
      `${listing.name} is listed at $${listing.priceUsd}, below the $${MIN_PRICE_USD} minimum this seller ` +
      `can charge. Real-world sellers meter these per row rather than per call.`
    );
  }
  return null;
}

export async function buyListing(opts: {
  account: Address;
  listing: Listing;
  payTo: Address;
  serverUrl: string;
  /**
   * A person clicked Buy at a price they could see, so the per-transaction
   * limit is waived and the listed price becomes binding instead. Leave false
   * for unattended buying, where the limit must still apply.
   */
  humanAuthorized: boolean;
}): Promise<BuyOutcome> {
  const { account, listing, payTo, serverUrl, humanAuthorized } = opts;

  const blocked = unbuyableReason(listing);
  if (blocked) {
    return { ok: false, listing, paidUsd: null, txHash: null, purchase: null, error: blocked };
  }

  const guard = new PaymentGuard({
    account,
    maxPerTxUsd: maxPerTxUsd(),
    maxTotalUsd: maxTotalUsd(),
    expectedPayTo: payTo,
    ...(humanAuthorized ? { humanAuthorizedPriceUsd: listing.priceUsd } : {}),
  });
  await guard.refreshBalance();
  const payer = await buildPayer(guard);

  const result = await payOnce({
    payer,
    guard,
    serverUrl,
    task: listing.name,
    path: "/premium",
    askPriceUsd: listing.priceUsd,
  });

  if (!result.ok) {
    return {
      ok: false,
      listing,
      paidUsd: null,
      txHash: null,
      purchase: null,
      error: result.error ?? result.blockedReason ?? "payment did not complete",
    };
  }

  const paid = result.paidUsd ?? listing.priceUsd;
  // The product IS the listing — not the placeholder payload our own endpoint
  // happened to return.
  const purchase = recordPurchase(account, {
    productId: listing.name,
    productName: listing.description.slice(0, 80) || listing.name,
    usd: paid,
    params: { network: listing.networkLabel },
    txHash: result.txHash,
    data: {
      // A full snapshot of the listing as it was shown at the moment of sale,
      // icon included, so the library can render the card without going back to
      // the registry — where this listing may since have changed or vanished.
      listing: {
        id: listing.id,
        name: listing.name,
        provider: listing.provider,
        url: listing.url,
        description: listing.description,
        priceUsd: listing.priceUsd,
        listedPriceUsd: listing.rawPriceUsd,
        network: listing.networkLabel,
        iconUrl: listing.iconUrl,
        tags: listing.tags,
      },
      source: "x402 Bazaar (Coinbase discovery registry)",
      settledLocally: true,
      note: "Payment went to your own seller wallet. The third-party API was not called.",
    },
  });

  return { ok: true, listing, paidUsd: paid, txHash: result.txHash, purchase, error: null };
}
