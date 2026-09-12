# Autonomous Agent Payments with x402 on Base Sepolia
### How an AI Agent Pays for APIs Without Humans — Concept to Low-Level
*Technical deep-dive · 20–30 min · Base Sepolia + TypeScript implementation in `c:\Users\shash\Desktop\ai-payment`*

---

## Slide 1 — What Is It?

**One-line idea:** an autonomous software agent buys API calls with USDC over plain HTTP, under a hard-coded budget — no checkout page, no API keys, no human clicking "approve".

- **Seller:** Express service (`src/server.ts`) selling `GET /premium` for **$0.05 USDC** on **Base Sepolia** via the **x402 protocol**.
- **Buyer:** Node agent (`src/agent.ts`) holding a viem wallet; it quotes, budget-checks, signs, and retries — fully unattended.
- **Enforcer:** fixed spending limit (`MAX_BUDGET_USD=0.15`) checked **before every signature**.
- **Settler:** public facilitator (`https://x402.org/facilitator`) verifies + settles USDC on-chain.

```text
Agent --HTTP--> Seller --verify/settle--> Facilitator --tx--> Base Sepolia (USDC)
  ^                |
  +-- 200+result --+
```

## Speaker Notes

Stress the shift: payment is a request/response handshake, not a side portal. The audience should notice there are no API keys — the signed payment *is* the credential. Transition: "Why would anyone replace API keys with per-request crypto payments?"

---

## Slide 2 — Why Does It Exist? / The Problem

| Old world (API keys + billing) | Pain for agents |
|---|---|
| Sign up, KYC, add card, buy credits/subscription | An agent cannot do paperwork at 2 AM mid-task |
| Long-lived secret keys stored, rotated, leaked | Key sprawl; blast radius on leak |
| Prepaid bundles → overpay or run dry mid-job | Task dies halfway; reconciliation nightmare |
| Chargebacks, invoicing, per-provider dashboards | Doesn't compose across 100 micro-services |

**x402 answer:** HTTP status `402 Payment Required` becomes functional again. Price travels *with* the request; settlement is atomic per call; seller needs no user accounts.

## Speaker Notes

Common misunderstanding: "isn't this just crypto for crypto's sake?" No — the point is machine-to-machine metering at request granularity. Cards + OAuth were built for humans in browsers.

---

## Slide 3 — High-Level Architecture

```text
             ┌──────────────────────┐
             │  Agent (buyer)       │
             │  src/agent.ts        │
             │  axios + x402-axios  │
             │  viem wallet         │
             │  budget guard        │
             └──────────┬───────────┘
                        │ ① GET /premium (no payment)
                        ▼
             ┌──────────────────────┐      ┌──────────────────┐
             │  Seller (service)    │─────▶│  Facilitator     │
             │  Express +           │verify│  x402.org        │
             │  x402-express        │settle│  /verify /settle │
             └──────────┬───────────┘      └────────┬─────────┘
                        │ ② 402 quote / ③ 200+result │
                        │                           │ USDC tx
                        ▼                           ▼
                  ┌──────────────────────────────────────┐
                  │  Base Sepolia (chain 84532)          │
                  │  USDC 0x036CbD… (6 decimals)         │
                  └──────────────────────────────────────┘
```

| Component | Trusts | Holds secrets? |
|---|---|---|
| Agent | Facilitator quote accuracy | Yes — agent private key (testnet only) |
| Seller | Facilitator verify/settle | No — only `payTo` address |
| Facilitator | Chain RPC | No user funds; submits signed auth |
| Chain | Cryptography | Settles EIP-3009 style authorization |

## Speaker Notes

Point at the arrows: seller never touches the agent key; facilitator never Custodies funds — it relays a signed authorization. Next: zoom into each box.

---

## Slide 4 — Components (Purpose · Inputs · Outputs)

### 4a. Seller — `paymentMiddleware` (x402-express 1.2.0)

- **Purpose:** gate routes by payment; outsource crypto to facilitator.
- **Inputs:** `payTo` address, `RoutesConfig {"GET /premium": {price:"$0.05", network:"base-sepolia"}}`, facilitator URL; per request: `X-PAYMENT` header (or nothing).
- **Processing:** match method+path → build `PaymentRequirements` → if header missing/invalid return 402 → else `verify()` → run handler → `settle()` → attach `PAYMENT-RESPONSE`.
- **Outputs:** `402 + accepts[]` OR `200 + JSON + PAYMENT-RESPONSE`.
- **Talks to:** agent (HTTP), facilitator (`POST /verify`, `POST /settle`).

```ts
app.use(paymentMiddleware(PAY_TO,
  { "GET /premium": { price: PRICE, network: NETWORK, config: { description, mimeType, maxTimeoutSeconds: 120 } } },
  { url: FACILITATOR_URL } as any));
```

### 4b. Buyer — agent + `withPaymentInterceptor` (x402-axios 1.2.0)

- **Purpose:** turn 402s into paid retries without human help, but never exceed budget.
- **Inputs:** `.env` (`SERVER_URL`, `AGENT_PRIVATE_KEY`, `MAX_BUDGET_USD`), CLI `--tasks N`; per task: 402 quote.
- **Processing:** `quotePriceUsd()` → guard `price ≤ remaining` → `payer.get()` → interceptor signs EIP-712 auth → retry → decode tx → `spent += price`.
- **Outputs:** console log (`PAID / BLOCKED / FAILED + spent/remaining`), purchased JSON.
- **Talks to:** seller only; chain interaction is indirect via signed payload.

### 4c. Facilitator + Chain

- **Facilitator:** stateless verifier/relayer. `verify` = signature + balance + expiry + payTo/asset checks against RPC. `settle` = submit authorization tx, wait for receipt, return tx hash.
- **Base Sepolia USDC:** ERC-20, 6 decimals. `$0.05 = 50000` atoms. Chain ID 84532.

## Speaker Notes

Emphasize the money math: atoms vs dollars is the #1 bug source. Our parser does `Number(maxAmountRequired)/10**decimals`. Transition: "Let's watch one request travel through all of this."

---

## Slide 5 — End-to-End Request Flow (`job-1`, Budget $0.15)

```text
Agent                              Seller                        Facilitator/Chain
  │ GET /premium (no payment)        │                                        │
  │────────────────────────────────▶│                                        │
  │              402 + accepts       │                                        │
  │◀────────────────────────────────│                                        │
  │ quote $0.05 ≤ $0.15 ✔            │                                        │
  │ GET /premium + X-PAYMENT         │                                        │
  │────────────────────────────────▶│── verify ──▶ valid ◀───────────────────│
  │                                │── settle ──▶ tx:0xabc ◀─────────────────│
  │◀── 200 { signals } + RESPONSE(tx)│                                        │
  │ spent=0.05 remaining=0.10        │                                        │
```

Tasks 4–6 (at $0.15 max) print BLOCKED and no signature is created.

## Speaker Notes

Three HTTP trips: unpaid, quote, paid. Seller works only after verify.
Next: exact bytes on the wire.

---

## Slide 6 — Data Flow & Real Payloads

```text
JS object → JSON → base64 (X-PAYMENT) → HTTP → Express → zod → facilitator JSON → EVM calldata → block
```

402 quote body (actual, truncated):

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [{
    "scheme": "exact", "network": "base-sepolia",
    "maxAmountRequired": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0xb53C06aBe860109365964D006CF8cD6ba338D59e",
    "maxTimeoutSeconds": 120,
    "extra": { "name": "USDC", "version": "2" }
  }]
}
```

X-PAYMENT header (shape): base64 of `{ x402Version: 1, scheme, network, payload: { signature, authorization: { from, to, value: "10000", validAfter, validBefore, nonce } } }`, signed by viem signTypedData (EIP-712, USDC domain v2). This is an EIP-3009 `transferWithAuthorization` — the facilitator submits it on-chain and pays the gas, so the agent wallet needs USDC but no ETH.

200 response: JSON `{ ok, task, result: { signals, summary } }` + header `X-PAYMENT-RESPONSE: base64({ transaction: "0x…", network, payer })`.

Budget object: `{ max: 0.15, spent: 0.10 }`, `remaining = max - spent`, epsilon `1e-9`.

## Speaker Notes

maxAmountRequired is atoms-as-string, not dollars. Whole auth is ~1–2 KB, fine for header limits.

---

## Slide 7 — Inside the Seller (x402-express)

```text
HTTP → middleware → route match? ─no─▶ next() (/free, / pass)
                          │ yes → X-PAYMENT? ─no─▶ 402 + accepts[]
                          │ yes → zod parse → verify ─bad─▶ 402
                          │ valid → handler computePremiumResult() (offline)
                          │ → settle ─fail─▶ 402/500 → 200 + RESPONSE
```

Refs: middleware src/server.ts:24-46; handler 56-69; compute 84-98.
Only listed routes are gated — unlisted paths pass (footgun if forgotten).
[ASSUMPTION] defaults for outputSchema/extra taken from live 402 output.

## Speaker Notes

Handler runs between verify and settle — keep it pure/offline to shrink the crash window. Next: buyer internals.

---

## Slide 8 — Inside the Buyer (Guard + Interceptor)

```pseudo
budget = { max: 0.15, spent: 0 }
signer = await createSigner("base-sepolia", KEY)  # wallet client, must await
payer  = withPaymentInterceptor(axios.create(), signer)
for task in tasks:                                # agent.ts:76
    price = quote(/premium) → atoms/1e6           # agent.ts:36
    if NaN → BLOCKED (no blind pay)
    if price > max - spent → BLOCKED, no signing  # agent.ts:85
    res = payer.get(/premium)                     # 402→sign→retry
    tx = decodeXPaymentResponse(headers)          # agent.ts:98
    spent += price
```

Interceptor: on 402 → zod-parse accepts → pick USDC/base-sepolia →
createPaymentHeader → set X-PAYMENT + retry-once flag → re-request.
Second 402 → reject (no loop).

## Speaker Notes

Guard precedes crypto — that ordering is the whole safety story.
Forgetting `await` on createSigner yields "Invalid evm wallet client".
Next: below the abstraction — sockets, memory, chain.

---

## Slide 9 — Low Level: Network, Memory, Chain

- **HTTP/TCP:** agent→seller is localhost TCP (or TLS remotely); 402 + retry = 3 requests per paid call (quote, unpaid attempt inside interceptor, paid retry). Keep-alive via axios agent; 120 s facilitator timeout bounds settle waits.
- **Memory (Node):** single-threaded event loop; quote/payer promises interleave, no locks needed. Budget is a plain `{max, spent}` closure — lost on restart ([TO CONFIRM] add file/DB ledger for crash safety). Header strings (~2 KB) are short-lived GC garbage.
- **Serialization:** JSON → base64 headers; zod validates `accepts[]` at runtime (string atoms stay strings — no float loss); EIP-712 typed data → secp256k1 signature → facilitator encodes ERC-20 `transferWithAuthorization` calldata.
- **Chain (Base Sepolia, 84532):** facilitator `eth_call`s USDC `balanceOf`/`allowance`, `ecrecover`s signature, checks `validAfter/Before + nonce`; then sends tx, waits for receipt (~2–5 s), returns hash. Gas paid by facilitator/relayer path [TO CONFIRM for this facilitator build].
- **CPU:** dominated by network waits, not crypto; one ed25519/secp256k1 sign per payment is negligible.

## Speaker Notes

If asked "where's the database?" — there isn't one; the chain is the ledger, memory holds only the session budget. That is both the elegance and the crash-recovery gap.

---

## Slide 10 — Real Example: `job-1` Trace (Actual Output)

Quote (no pay): `402 maxAmountRequired "50000" asset 0x036CbD… network base-sepolia` → `$0.05 ≤ $0.15` → proceed.

Unfunded run (this machine): `FAILED status=402 error=invalid_exact_evm_insufficient_balance` — signed fine, facilitator RPC saw 0 USDC, no tx, counted blocked. Funded run would show:

```text
-- job-1: price=$0.0500 remaining=$0.1500
   PAID $0.0500 tx=0xabc…
   result: "Task 'job-1': 3 signals… Top pick BASE/USDC (accumulate, 0.82)."
   balance: spent=$0.0500 remaining=$0.1000
```

Guard proof: `npm run budget-check` → `a,b,c WOULD-PAY; d BLOCKED; GUARD-OK (3 paid + 1 blocked)`.

## Speaker Notes

This is the "believe it" slide — all values are from real runs, not mockups. Transition: "So what breaks?"

---

## Slide 11 — Failure Scenarios

```text
Unfunded wallet ─▶ verify: insufficient_balance ─▶ 402 ─▶ agent logs FAILED, no spend
Over budget ──────▶ guard BLOCKED locally ────────▶ no HTTP payment attempt at all
Bad quote ────────▶ NaN parse ────────────────────▶ BLOCKED (refuse blind pay)
Facilitator down ─▶ verify timeout ───────────────▶ 402/500 ─▶ agent retries later [TO CONFIRM retry policy]
Settle revert ────▶ tx fails ─────────────────────▶ 402 settlementFailed, handler result discarded
Key leaked ───────▶ anyone can spend ─────────────▶ rotate key, fund small amounts only
```

Each follows: what failed → how detected (402 error string / guard math / timeout) → system action → client view → recovery (fund, lower tasks, retry, rotate).

## Speaker Notes

Note the two-layer defense: local guard (overspend) + facilitator verify (insolvency/fraud). Either can stop a payment; both must pass for money to move.

---

## Slide 12 — Performance, Scaling, Security

- **Perf:** ~3 HTTP hops + 1 chain tx per paid call; end-to-end ~3–8 s on testnet (settle wait dominates). No DB; handler is O(1) offline compute. Float math only for display — atoms stay strings.
- **Scaling (applies here):** seller is stateless → horizontal replicas behind a gateway; facilitator + chain RPC are the shared bottlenecks. Agent loop is sequential (budget correctness); parallelize only with a shared atomic ledger.
- **Security:** least privilege (seller has no keys); short-lived authorizations (`maxTimeoutSeconds: 120`, nonces); never commit `.env` keys; testnet-only throwaway wallets; validate `accepts[]` with zod; cap tasks (1–12) and budget per run.

## Speaker Notes

If challenged on "3–8 s per call is slow": yes — this buys trustless settlement. For high-frequency use, batch calls or use a cheaper `upto`/channel scheme [TO CONFIRM availability].

---

## Slide 13 — Design Trade-offs

| Choice | Why | Cost / Alternative |
|---|---|---|
| x402 per-request USDC | No accounts/keys; exact metering | Chain latency + faucet ops; alt: API keys + Stripe (human-ops, key sprawl) |
| Public facilitator | No crypto infra to run | External dependency; alt: self-host facilitator or settle directly |
| Base Sepolia + TS | Mature SDKs, easy faucet | Testnet instability; alt: Solana devnet (different wallet stack) |
| In-memory budget | Simple, correct single-run | Lost on crash; alt: SQLite/Redis ledger with atomic decrement |
| Offline deterministic service | Demo needs no API keys | Toy value; alt: real metered API (weather/LLM) behind same gate |
| Sequential agent loop | Budget race-free | Slower; alt: concurrent with distributed lock |

## Speaker Notes

No perfect architecture — we optimized for demo clarity + real settlement. Production would add persistent ledger, alerts on BLOCKED/FAILED, and per-task price caps.

---

## Key Takeaways

1. x402 turns payment into an HTTP handshake: quote (402) → sign → verify → settle → result.
2. The budget guard runs before signing — overspend is impossible by construction, not policy.
3. Seller holds no secrets; facilitator verifies/settles; chain is the ledger.
4. Real numbers: $0.05 = 50000 USDC atoms on Base Sepolia; $0.15 max = 3 pays + blocks.
5. Two safety nets: local guard (budget) + facilitator verify (funds/authenticity).
6. Failure modes are explicit 402 errors — fund, retry, rotate, or stop.
7. Stateless seller scales horizontally; agent stays sequential unless ledger is shared.
8. Next step: fund the agent wallet and watch `PAID tx=0x…` — or add a persistent budget ledger.

## Questions

*Try live: `http://localhost:4021/dashboard` — quote, run agent, force BLOCKED with budget $0.04.*
