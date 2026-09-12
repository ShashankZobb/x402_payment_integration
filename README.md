# AI Agent Pays for a Service — x402 on Base Sepolia

Autonomous agent pays for a useful service (`GET /premium`) via the
[x402](https://www.x402.org/) protocol on **Base Sepolia testnet** with USDC,
enforcing a **per-transaction spending limit before each payment**.
No human approves each payment — the guard does.

## The three checks before any money moves

Every payment passes through `PaymentGuard.select` ([src/guard.ts](src/guard.ts)),
which x402-axios calls with the *real* payment requirements immediately before
signing. Whatever it returns is exactly what gets paid; throwing aborts before a
signature exists.

1. **Linked account** — the quote must be `exact` scheme, on `base-sepolia`,
   denominated in the verified USDC contract, and payable to the configured
   `SERVER_PAYTO`. Anything else is refused.
2. **Max limit** — the price must not exceed `MAX_PER_TX_USD`. This is checked
   **per transaction**: it caps the size of any single payment, and prior
   spending never enters into it. Ten calls under the limit are ten allowed
   payments. An optional cumulative ceiling (`MAX_TOTAL_USD`) can be layered on
   top, but it is off unless you set it.
3. **Balance** — the on-chain USDC balance must cover the price. The agent will
   not sign an authorization the wallet cannot fund.

## How it works

1. Agent `GET /premium?task=job-1` with no payment.
2. Server replies `402 Payment Required` + `accepts: [{ $0.01 USDC (10000 atoms), network base-sepolia, payTo }]`.
3. Agent runs the three checks above.
   - any check fails → **BLOCKED**, no signature created.
   - all pass → signs an EIP-3009 `transferWithAuthorization`, retries with `X-PAYMENT`.
4. Server `paymentMiddleware` verifies via facilitator
   (`https://x402.org/facilitator`), which **submits the transaction and pays the
   gas**, then runs the service and returns `200 + result + PAYMENT-RESPONSE` (tx hash).
5. Agent appends the payment to the ledger with its tx hash.

> The agent needs **USDC only — no ETH**. Settlement gas is paid by the facilitator.

## Quickstart

```powershell
npm install
npm run wallets        # generates + saves AGENT and SERVER wallets into .env
# Fund AGENT_ADDRESS with Base Sepolia USDC:
#   https://faucet.circle.com -> USDC -> Base Sepolia
#   contract: 0x036CbD53842c5426634e7929541eC2318f3dCF7e

npm run budget-check   # offline: 27 guard assertions, no funds needed
npm run server         # terminal 1  -> http://localhost:4021/dashboard
npm run agent          # terminal 2  -> pays, or blocks over the limit
# or just open http://localhost:4021/dashboard and click Send request
npm run balance        # USDC + limit + total paid
```

## Verified live (this machine)

- `npm run budget-check` → `GUARD-OK`, 27/27 assertions.
- `GET /health` → `200` (free). `GET /premium` (unpaid) → `402`.
- `npm run agent` at a `$0.05`/tx limit, price `$0.01` → all tasks paid with real
  tx hashes; on-chain balance falls by exactly the amount paid.
- `MAX_PER_TX_USD=0.005 npm run agent` → every task
  `BLOCKED: price $0.0100 exceeds the per-transaction limit $0.0050`, no payment attempted.
- `MAX_PER_TX_USD=abc npm run agent` → exits 1 without paying.
- `POST /api/pay` without the session token → `403`; with a junk price → `400`
  naming the specific problem (not a number / negative / zero / out of range).
- With the facilitator pointed at a black hole and `REQUEST_TIMEOUT_MS=6000`:
  times out in 7s, confirms on-chain that no funds moved, records nothing.

## Config (.env)

| Var | Meaning |
|---|---|
| `SERVER_PAYTO` / `AGENT_PRIVATE_KEY` | Written by `npm run wallets`. The agent address is derived from the key. |
| `SERVER_PRIVATE_KEY` | The seller's key. Optional to run, required to `sweep` — without it, earnings are unspendable. Cross-checked against `SERVER_PAYTO` at startup. |
| `MAX_PER_TX_USD` | **The limit.** Largest single payment allowed. Must be a finite non-negative number — a malformed value aborts startup rather than silently disabling the check. `MAX_BUDGET_USD` still works as a legacy alias. The dashboard's **Cap per call** box overrides it at runtime, saved to `.settings.json`; clearing the box restores this value. |
| `MAX_TOTAL_USD` | Optional cumulative ceiling across all payments. Unset = no running total is enforced. |
| `PRICE_PER_CALL` | Seller default price, e.g. `$0.01`. The dashboard's Price box overrides it per call. |
| `REQUEST_TIMEOUT_MS` | Budget for one paid request including retries (default 45000, clamped 5000-180000). |
| `FACILITATOR_URL` | `https://x402.org/facilitator` |
| `RPC_URL` | Optional Base Sepolia RPC override. |
| `ANTHROPIC_API_KEY` | Required for the AI agent. Without it, use `MOCK_AI=1`. |
| `AGENT_MODEL` | Defaults to `claude-opus-5`. |

Payment history lives in `.spend-ledger.json`, keyed by account address. It is a
record, not a gate — deleting it changes nothing about the per-transaction limit,
and only matters if you have set `MAX_TOTAL_USD`.

## Settlement failures

The public `x402.org` facilitator relays transactions for many users from a
single wallet. When two settlements race, its relayer reuses its own EVM nonce
and the RPC rejects the loser with `replacement transaction underpriced`. This
shows up as a `402` even though the payer's signature was perfectly valid — it
is the facilitator colliding with itself, not a problem with the payment.

On any failure the agent asks USDC directly whether the authorization it signed
was consumed, via EIP-3009 `authorizationState(authorizer, nonce)`:

| chain says | agent does |
|---|---|
| consumed | counts it as **PAID** — the money moved, whatever the HTTP error said |
| not consumed | no funds moved; **retries** up to twice for transient errors |
| unreachable | records the payment as `unconfirmed` so it stays visible |

Retrying only after an on-chain *not consumed* matters: the original
authorization stays replayable until `validBefore`, so a blind retry could pay
twice.

Verified across 124 payments: ledger total `$1.2400` against an on-chain balance
drop of `19.00 → 17.76` USDC — an exact match, with the collisions recovered.

## Shop with AI

Describe what you want and set an auto-buy threshold:

```
"sentiment and a full report on ETH"      auto-buy under $0.05
  -> sentiment    $0.02   AUTO-BOUGHT
  -> fx-rate      $0.005  AUTO-BOUGHT
  -> deep-report  $0.10   SUGGESTED  [ Buy $0.1 ]
```

Claude matches your request against the catalog in a **single structured call** —
not an agent loop. It decides what is *relevant*; the buying that follows is
ordinary code, so the money path stays deterministic and auditable.

Anything priced **under** the threshold is bought immediately; everything else
comes back with a Buy button for you to approve. `0` suggests everything and
buys nothing.

### Who is allowed to spend what

| | bounded by |
|---|---|
| **Auto-buy** (unattended) | `min(your threshold, MAX_PER_TX_USD)` — the agent can never spend more without you than its limit allows |
| **You clicking Buy** | no ceiling at all; the quote must simply equal the listed price |

The per-transaction limit exists to bound an agent spending on its own. A person
who read the price and clicked Buy *is* the authorisation, so the limit is
waived — `deep-report` at $0.10 is refused for the agent and bought without
complaint when you click it.

What replaces the limit is a **price-match check**: the seller's quote must equal
what the card advertised, so a bait-and-switch at checkout is refused in either
direction. Network, asset, payee and balance checks always apply. See
`humanAuthorizedPriceUsd` in [src/guard.ts](src/guard.ts).

## Marketplace — real listings from the x402 registry

The **Marketplace** panel is populated from Coinbase's public x402 discovery
registry ([src/bazaar.ts](src/bazaar.ts)) — roughly 14,500 live services. It
renders as a product grid with everything the sellers publish:

| shown | coverage |
|---|---|
| product image | 28% (a monogram in a stable per-provider colour otherwise) |
| seller's own product name | 88% (else derived from the URL) |
| tags, as chips | 88% |
| description, price, network | 100% |

Searchable, price-filterable, and sortable by **Featured / Cheapest / Dearest**.

The catalog is cached for **5 minutes**; **Refresh** forces a refetch. Where a
seller's name repeats across endpoints ("Otto AI" ×10) the distinguishing path
is appended, so products stay identifiable in a list.

Featured is not registry order: the registry's first pages are dominated by one
provider whose entries carry no name, icon or tags, so an unsorted page showed
the least presentable listings in the catalog. Featured ranks by how complete a
listing is, which is what puts real logos and brand names on the front page.

**Buying settles to your own seller wallet.** It is a genuine x402 payment of
the listed price, through your own server, into `SERVER_PAYTO` — and the
listing's details are recorded as the purchased product. The third-party API is
*not* called, and the UI says so in a banner rather than implying otherwise.

That is deliberate: those sellers speak **x402 v2** (requirements in a
`PAYMENT-REQUIRED` header, CAIP-2 networks like `eip155:84532`, `amount` instead
of `maxAmountRequired`), while every client library on npm is still v1. Paying
them for real needs a v2 client that does not exist yet.

### Reading prices from a non-uniform registry

Sellers do not agree on units. Some quote `amount` in atoms (`"1000"`), others in
whole token units (`"0.0001"`), and the field is `maxAmountRequired` on v1
entries and `amount` on v2. Magnitude tells them apart:

| amount | read as | conversion |
|---|---|---|
| above 1 | atoms | `/ 1e6` |
| 1 or below | token units | `/ 1000` |

Whatever the asset, the result is taken as dollars — every stablecoin in the
registry is dollar-denominated.

Across 600 listings this gives min `$0.000002`, median `$0.005`, p90 `$0.05`,
and prices the genuinely expensive ones correctly: a `$11.50` bank payment, a
`$1000` Bitrefill invoice.

Two bands cannot be charged through the local seller, and Buy says which rather
than failing oddly:

- **above `$5`** — the demo's ceiling (3 listings)
- **below `$0.0001`** — beneath what USDC can settle per call; these are real
  services metered per row rather than per request (18 listings)

```
GET  /api/market?q=weather&maxUsd=0.01   search live listings
POST /api/buy-listing { listingId }      pay your wallet, record the product
```

> The **Shop with AI** panel still matches against the local demo catalog in
> [src/catalog.ts](src/catalog.ts), not the registry.

## Demo catalog and purchased goods

The dashboard has a **Marketplace** panel listing what the seller offers — name,
price, description, and the inputs each product takes, all read from
[src/catalog.ts](src/catalog.ts). Click **Buy** and:

1. payment goes to **your own seller wallet** (`SERVER_PAYTO`) over x402,
2. through the same `PaymentGuard` as everything else, and
3. the delivered data is kept in **Purchased**, expandable to see exactly what
   you got for the money.

`deep-report` costs $0.10 against a $0.05 per-call limit, so it is marked in red
and the guard refuses it — a one-click demonstration that the limit is real.

Purchased goods live in `.purchases.json`, deliberately **separate** from
`.spend-ledger.json`. The ledger is the financial record the spending chart and
the optional total cap read; the purchases store is the library of what those
payments bought. A purchase is only ever written after money actually moved — a
refused payment is reported, never stored.

```
GET  /api/catalog     what is for sale
POST /api/buy         { productId, params }  -> pays, then stores the goods
GET  /api/purchases   the library, newest first, with the data
```

## The agent that decides what to buy

Give it a task in plain English and it works out which paid services to buy:

```powershell
npm run server                                  # terminal 1
npm run task -- "what is ETH doing?" --budget 0.05   # terminal 2
```

Or use the **Give the agent a task** panel on the dashboard.

Claude gets two tools — `list_services` (free) and `call_service` (costs money)
— and loops: survey the catalog, buy what the question needs, read the result,
decide what is next. Every purchase still goes through the same `PaymentGuard`.

**The model chooses what to buy; the guard decides whether it is allowed.**
When a purchase is refused, the refusal comes back as a *tool result*, not an
exception, so Claude can adapt — pick something cheaper, or explain what it
could not do. Spending limits are enforced in code at signing time, never
requested politely in a prompt.

Two independent caps apply:

| cap | set by | bounds |
|---|---|---|
| `MAX_PER_TX_USD` | `.env`, or the dashboard's **Cap per call** (run-token gated, persisted) | any single payment |
| task budget | per request, clamped server-side | everything one task spends |

### The catalog

| service | price | |
|---|---|---|
| `fx-rate` | $0.005 | one exchange rate |
| `market-signal` | $0.01 | signals across major pairs |
| `sentiment` | $0.02 | sentiment for one asset |
| `deep-report` | $0.10 | full report — **above** the default $0.05 per-tx limit |

`deep-report` is deliberately unaffordable under the default limit, so the
refusal path is reachable on demand rather than hypothetical.

The catalog in [src/catalog.ts](src/catalog.ts) is the single source for the
x402 route config, the HTTP handlers, and what the agent is shown — so the price
Claude reasons about, the price the 402 quote advertises, and the price the guard
validates are the same number by construction. A test asserts it.

### Running the agent for free

**With no `ANTHROPIC_API_KEY`, keyword ranking is used automatically** — nothing
to set, and the dashboard says which matcher ran so a keyword hit is never
passed off as the model's judgement. `MOCK_AI=1` forces it even when a key is
present.

Keyword ranking works over the same marketplace catalog.
No API key, no tokens, and the payment path, guard, thresholds and ledger are
all genuinely exercised.

For requests shaped like **"buy 10 Otto AI products"** — a quantity and a brand
— keyword ranking is enough: a hit in the product name or provider scores far
higher than one in prose, so the right seller wins. It has no semantics, so
"how do people feel about ETH" still will not find a sentiment API. When nothing
matches it says so and buys nothing, because spending on a guess is worse than
spending nothing.

Combine with `MOCK_PAYMENTS=1` for a demo that costs nothing at all:

```powershell
MOCK_PAYMENTS=1 MOCK_AI=1 npm run task -- "what is ETH doing?"
```

> A task typically costs **more in Claude tokens (~2-5c)** than in the USDC it
> spends (~1-3c). That is the honest economics of small-value agentic commerce
> today, and worth seeing rather than hiding.

## The two wallets

| | role | needs |
|---|---|---|
| **AGENT** (`AGENT_PRIVATE_KEY`) | spends | USDC. No ETH — the facilitator pays settlement gas. |
| **SELLER** (`SERVER_PAYTO` + `SERVER_PRIVATE_KEY`) | receives | nothing to receive; a little ETH only to send funds back out |

`npm run wallets` creates whatever is missing and **leaves existing wallets
alone** — it will not replace a funded wallet without being told to.

```powershell
npm run wallets                     # fill in what's missing
npm run wallets -- --force          # proceed even if a replaced wallet holds USDC
npm run wallets -- --rotate-agent   # also replace the AGENT wallet (it holds your funds)
```

If a wallet being replaced still holds USDC, it refuses and names the amount.
`--force` only bypasses that check; replacing the funded agent wallet is a
separate flag so it can never happen as a side effect.

### Getting earnings back out

```powershell
npm run sweep                  # dry run — what would move
npm run sweep -- --confirm     # send it
npm run sweep -- --to 0xabc…   # somewhere other than the agent wallet
```

**This needs gas.** Moving USDC out is an ordinary ERC-20 transfer, and the x402
facilitator only pays gas for its own settlement flow — it will not relay this.
A seller wallet that has only ever *received* x402 payments therefore holds zero
ETH, and `npm run sweep` will say so and link the faucet rather than failing
with a revert. A few cents of Base Sepolia ETH is enough.

> Earlier versions generated the seller keypair and discarded the private key,
> so payments went to an address nobody could spend from. If your `.env` has no
> `SERVER_PRIVATE_KEY`, anything already paid to that `SERVER_PAYTO` is
> unrecoverable — `npm run wallets -- --force` creates a seller you control.

## Testing without spending

Real payments cost real (testnet) USDC, so there is a mock mode:

```powershell
npm run mock:server            # terminal 1
npm run mock:agent -- --tasks 6   # terminal 2
```

Or set `MOCK_PAYMENTS=1` for any command. What stays **real**: the 402 quote,
every `PaymentGuard` check, the retry and reconciliation branches, the ledger,
the chart, the whole UI. What is **simulated**: the EIP-3009 signature, the
facilitator, and the balance (starts at `MOCK_USDC`, default 25).

Mock payments are written to `.spend-ledger.mock.json`, a separate file, so
simulated spending can never contaminate real history or the spending chart.
The dashboard shows a **MOCK MODE** badge whenever it is on, and mock
transaction ids are deliberately not hash-shaped so they never become dead
explorer links.

`MOCK_FAIL_RATE=0.3` injects transient settlement failures, so the retry path
can be exercised on demand instead of waiting for the public facilitator to
collide with itself.

## Dashboard

`http://localhost:4021/dashboard` has two panels — **Wallet** (balance, funding,
the per-call limit, total paid, recent payments) and **Make a request** (task +
price, then the x402 flow as a Quote → Limit check → Payment → Result timeline).
A **Spending** chart plots the ledger over a selectable range — **24h**
(hourly buckets), **7d**, **14d** or **30d** (daily). Empty buckets are shown as
zeroes so gaps are not compressed, and below two active buckets it states the
total instead of drawing a single bar.

The Price box sets what the *service charges*; the agent's own limit is policy,
and the two are separate on purpose. The limit comes from `MAX_PER_TX_USD` or
from the dashboard's **Cap per call** box — the operator's own, run-token-gated
surface — and never from the request being paid for. A seller cannot raise the
limit by asking for more; quoting above it is the quickest way to watch the
guard refuse a payment.

## Security notes

- `.env` holds a private key and is gitignored. Testnet only — never reuse the
  key on mainnet.
- `/api/pay` moves funds, so it is `POST` and requires a per-boot
  `X-Run-Token` that is injected into the dashboard page. A cross-origin page
  cannot read that token, so it cannot trigger a spend.
- A limit supplied by the dashboard can only *lower* it; the server clamps the
  value to `PER_TX_CEILING_USD` before passing it to the agent.
- With no cumulative cap set, the per-transaction limit bounds each payment but
  not the total across many calls — a 12-task run at `$0.05`/tx can spend `$0.60`.
  Set `MAX_TOTAL_USD` if you want a hard stop on the total.
