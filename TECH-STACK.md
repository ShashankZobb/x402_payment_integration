# Tech Stack & Code Flow — AI Agent Pays via x402 (Base Sepolia)

This doc explains what each technology does, why it was chosen,
and how the code flows end-to-end in `c:\Users\shash\Desktop\ai-payment`.

## 1. Tech stack

| Layer | Technology (version) | Role in this project |
|---|---|---|
| Runtime | Node.js v20.10.0 | Runs server + agent. Native fetch, ESM, top-level await. |
| Language | TypeScript 5.4 + tsx 4.7 | Type safety for prices/budget/headers. `tsx` runs `src/*.ts` directly. `tsc --noEmit` validates. |
| Web server | Express 4.18 | Serves `/`, `/free`, `/health`, `/premium`, dashboard + JSON APIs. Hosts x402 middleware. |
| HTTP client | axios 1.7.9 | Agent HTTP layer; `x402-axios` ships a ready interceptor for it. |
| Chain signing | viem 2.21.26 | Wallets (`generatePrivateKey`, `privateKeyToAccount`) + EIP-712 USDC authorizations. |
| x402 core | x402 1.2.0 | Types, `createSigner`, `PaymentRequirements` schema, `selectPaymentRequirements`, header encoding. Pinned: `x402-axios@1.2.1` needs a non-existent `x402@1.2.1`. |
| Seller SDK | x402-express 1.2.0 | `paymentMiddleware(payTo, routes, facilitator)` — 402 when unpaid; verify + settle then route handler. |
| Buyer SDK | x402-axios 1.2.0 | `withPaymentInterceptor(client, signer, selector)` + `decodeXPaymentResponse`. Auto sign + retry on 402. |
| Chain | Base Sepolia testnet | EVM testnet. USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals, verified on-chain). `$0.01` = `10000` atoms. |
| Facilitator | `https://x402.org/facilitator` | Verifies the payload, then **submits the transaction and pays the gas**. Seller holds no keys online. |
| Config | dotenv 16.4 | Loads `.env`, validated through `src/config.ts`. |

Why Base Sepolia + TS: most mature x402 path, free public facilitator,
easy Circle USDC faucet. Solana devnet would need Solana wallets + scheme.

## 2. Repo map

```text
package.json            # deps + scripts
tsconfig.json           # ES2022 + NodeNext, strict
.env / .env.example     # payTo, agent key, budget, price, facilitator
.spend-ledger.json      # payment history, keyed by account (gitignored)

src/config.ts           # validated config; fails closed on malformed limits
src/chain.ts            # one RPC + balance implementation, shared everywhere
src/ledger.ts           # durable payment record (+ optional total ceiling)
src/guard.ts            # THE enforcement point: validates the signed quote
src/settlement.ts       # what actually happened when a payment fails
src/agent.ts            # buyer: peek -> guard -> pay -> record
src/server.ts           # seller: Express + paymentMiddleware + dashboard APIs
src/budget-check.ts     # 27 offline assertions over the guard
src/env-file.ts         # shared .env read/write + wallet rotation
src/boot.ts             # start the server only if the wallet can pay
src/demo.ts             # server + agent back-to-back
src/balance.ts          # USDC + budget status
src/debug-pay.ts        # manual 402 debug helper
```

## 3. Code flow (happy path)

```text
agent GET /premium?task=job-1      (no X-PAYMENT)
  -> server paymentMiddleware
  -> 402 accepts[{ scheme:"exact", network:"base-sepolia",
       maxAmountRequired:"10000", asset:USDC, payTo }]

agent peekPriceUsd()                 (src/agent.ts)
  -> 10000 / 10^6 = $0.01
  -> cheap affordability check: skip the round trip if clearly unaffordable
     (an optimization ONLY — never the security boundary)

agent payer.get(/premium)
  -> interceptor catches 402 and calls PaymentGuard.select(requirements)
       1. network == base-sepolia, scheme == exact
       2. asset == verified USDC address   (NOT inferred from the quote)
       3. payTo == SERVER_PAYTO
       4. amount parses to a finite number
       5. amount <= on-chain USDC balance
       6. amount <= MAX_PER_TX_USD          <- the limit, per transaction
       7. amount <= remaining MAX_TOTAL_USD (only if that is configured)
     any failure throws -> no signature is ever created
  -> signs EIP-3009 transferWithAuthorization, retries with X-PAYMENT

server paymentMiddleware
  -> facilitator.verify(payload, requirements)
  -> facilitator.settle(...) -> facilitator submits the tx and pays gas
  -> computePremiumResult(task)
  -> 200 { result: { signals[3], summary } } + X-PAYMENT-RESPONSE(tx)

agent -> decodeXPaymentResponse() -> ledger.record(usd, task, tx)
```

## 4. Why the guard lives in the selector

The obvious design — quote the price, check it against the budget, then pay —
has a hole: the quote and the payment are two separate HTTP requests, each
getting its own `402`. The budget is validated against the first response while
the interceptor silently pays whatever the second one asks for. Nothing bounds
the amount actually signed.

`withPaymentInterceptor` takes a third argument, a `PaymentRequirementsSelector`,
which it invokes with the real requirements immediately before signing. Enforcing
there makes the check atomic with the payment: what the guard returns is exactly
what is paid, and throwing aborts with no signature in existence.

## 5. Per-transaction vs cumulative

The enforced limit is **per transaction**: `MAX_PER_TX_USD` caps the size of any
single payment and nothing else. Prior spending is not consulted, so the limit
behaves the same on the first call and the thousandth. This bounds the blast
radius of one bad quote — a seller that suddenly asks for `$50` is refused — but
it deliberately does not bound the total across many calls.

`src/ledger.ts` records every payment to disk under an atomic `mkdir` lock so
concurrent agent processes cannot clobber each other's entries. That record is
for visibility, and it backs the **optional** `MAX_TOTAL_USD` ceiling, which is
off unless set. Entries are written after the outcome is known: settled payments
carry their tx hash, and a payment signed but never confirmed is recorded as
`unknown` so it stays visible rather than vanishing.

```powershell
MAX_PER_TX_USD=0.05     # each payment <= $0.05      (enforced, always)
MAX_TOTAL_USD=1.00      # $1.00 across all payments  (optional, off by default)
```

## 6. Settlement failures and on-chain reconciliation

A `402` back from the seller covers two different situations. **Verify** failures
mean the facilitator rejected the payload — nothing was submitted. **Settle**
failures mean a transaction was attempted and the send did not stick; whether
money moved is not knowable from the error.

The common case against the public facilitator is
`replacement transaction underpriced`: its relayer submits for many users from
one wallet, two settlements pick the same account nonce, and the RPC rejects the
loser. The payer's signature was valid.

Guessing from the HTTP status is wrong here, so `src/settlement.ts` asks the
token instead. USDC's EIP-3009 implementation marks each authorization nonce as
consumed, and the signed nonce is recoverable from the failed request (x402-axios
leaves `X-PAYMENT` on the axios config):

```text
authorizationState(from, nonce) == true    -> the transfer executed; count it PAID
                                == false   -> no funds moved; safe to retry
                                unreachable-> record as `unconfirmed`
```

Retry only after a confirmed `false`. The original authorization remains
replayable until `validBefore`, so retrying blind risks paying twice.

## 7. Run it

```powershell
npm install
npm run budget-check   # offline guard proof -> GUARD-OK (27 assertions)
npm run server         # terminal 1 — http://localhost:4021/dashboard
npm run agent          # funded wallet -> PAID + tx; over the limit -> BLOCKED
npm run balance        # USDC + limit + total paid
npx tsc --noEmit       # typecheck
```
