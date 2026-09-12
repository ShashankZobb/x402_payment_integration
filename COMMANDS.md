# Full Command List — Fund, Run Server + Dashboard + Agent (Base Sepolia)

> One-time setup, then daily run. Copy-paste in order.
> Funding (Step 1) is done **in a browser** — no CLI can mint test funds.

## 0) Go to project + install (once)

```powershell
cd c:\Users\shash\Desktop\ai-payment
npm install
npx tsc --noEmit
npm run wallets     # writes AGENT + SERVER wallets into .env
```

`npm run wallets` prints the agent address. Every command below reads it from
`.env` — there are no hardcoded addresses to keep in sync.

## 0b) Where the money goes

Two wallets: **AGENT** spends, **SELLER** (`SERVER_PAYTO`) receives. Both are
written to `.env` by `npm run wallets`, including `SERVER_PRIVATE_KEY` — that
key is what lets you move earnings back out with `npm run sweep`.

`npm run wallets` never replaces a funded wallet silently; it refuses and names
the balance. Use `--force` to override, or `--rotate-agent` to also replace the
spending wallet.

```powershell
npm run sweep                 # dry run
npm run sweep -- --confirm    # move seller USDC back to the agent
```

Sweeping is a plain ERC-20 transfer, so the seller needs a little Base Sepolia
ETH for gas — the facilitator only covers gas for x402 settlement.

## 1) Add PAYMENT money (Base Sepolia USDC) — browser faucet

```powershell
npm run balance     # prints the agent address to fund
```

1. Open https://faucet.circle.com → asset **USDC**, network **Base Sepolia**
2. Paste the agent address → Send (20 USDC / 2h)
3. Contract: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
4. Verify: `npm run balance` → `USDC >= 1`

> **No ETH needed.** The x402 facilitator submits the EIP-3009 settlement
> transaction and pays the gas, so the agent wallet can hold zero ETH.

## 2) Prove the guard — no funds, no server, no chain

```powershell
npm run budget-check
```

Runs 27 assertions covering: malformed limits failing closed, untrusted limit
input from the dashboard, wrong-chain / wrong-asset / wrong-payee / unparsable
quotes, insufficient balance, the per-transaction limit (at, under and over),
the optional cumulative ceiling, and what the ledger records. Expect `GUARD-OK`.

## 3) Start server + dashboard (Terminal 1, keep open)

```powershell
npm run server
```

Open the test screen: http://localhost:4021/dashboard

If port busy (`EADDRINUSE :::4021`), an old server is still running:

```powershell
Get-NetTCPConnection -LocalPort 4021 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
npm run server
```

Or start it only when the wallet can actually pay:

```powershell
npm run boot                    # checks USDC, starts server only if funded
npm run boot -- --min-usdc 1    # require at least 1 USDC
npm run boot -- --fresh         # rotate wallets first (orphans existing funds)
```

## 4) Run the paying agent (Terminal 2)

```powershell
npm run agent                       # 4 tasks at MAX_PER_TX_USD
npm run agent:demo                  # 6 tasks
npx tsx src/agent.ts --tasks 12     # 12 tasks

# Drop the limit below the price for one run to watch the BLOCKED path:
$env:MAX_PER_TX_USD="0.005"; npm run agent
Remove-Item Env:MAX_PER_TX_USD      # clear it again — $env: persists for the session
```

Funded wallet, price under the limit → `PAID $0.0100 tx=0x…`.
Price over the limit → `BLOCKED: price $0.0100 exceeds the per-transaction limit $0.0050`.
Unfunded wallet → `BLOCKED [insufficient-balance]` before any signature.

**The limit is per transaction, not a running total.** Past spending never
blocks a new payment, so re-running the agent always works as long as each
individual price is under the limit and the wallet has USDC.

```powershell
npm run balance                     # limit + total paid so far
```

If you also want a hard stop on the cumulative total, set `MAX_TOTAL_USD` in
`.env`; `Remove-Item .spend-ledger.json` then resets that counter.

## 5) One-command full demo (server + agent back-to-back)

```powershell
npm run demo                    # starts server, waits on free /health, runs 6 tasks, stops server
npx tsx src/demo.ts --tasks 4   # shorter run
```

## 6) Dashboard (click, no CLI)

1. `npm run server` (Terminal 1)
2. Open http://localhost:4021/dashboard

Two panels:

- **Wallet** — USDC balance, funding status, the account address (click to copy),
  the per-call limit, and total paid. **Add USDC** copies the address and opens
  the faucet. Recent payments sit underneath, each linking to Basescan.
- **Make a request** — enter a task and a max per call, hit **Send request**.
  The x402 flow appears as a timeline (Quote → Limit check → Payment → Result)
  with the tx hash, then the service response is rendered below it. Raw JSON is
  behind the *Raw response* toggle.

Each click is a single real payment via `POST /api/pay`, which runs the same
guard, retry and on-chain reconciliation as the CLI agent. It carries a per-boot
token, so only a real page load can start a spend, and the max-per-call box can
only *lower* the limit — the server clamps it.

## Quick reference table

| Goal | Command |
|---|---|
| Install | `npm install` |
| Typecheck | `npx tsc --noEmit` |
| Wallets | `npm run wallets` |
| Balance + limit | `npm run balance` |
| Server + dashboard | `npm run server` → http://localhost:4021/dashboard |
| Server only if funded | `npm run boot` |
| Guard proof (offline) | `npm run budget-check` |
| Agent (4 / 6 / 12) | `npm run agent` · `npm run agent:demo` · `npx tsx src/agent.ts --tasks 12` |
| Full auto demo | `npm run demo` |
| Sweep seller earnings | `npm run sweep -- --confirm` |
| Clear payment history | `Remove-Item .spend-ledger.json` |
