import "dotenv/config";
import { NETWORK, agentAccount, failClosed, fmtUsd, maxPerTxUsd, maxTotalUsd, payToAddress } from "./config.js";
import { basescanUrl } from "./chain.js";
import { PaymentGuard } from "./guard.js";
import { MOCK_BANNER, isMockMode } from "./mock.js";
import { buildPayer, payOnce, type PayStep } from "./pay.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4021";

function parseTasksArg(): string[] {
  const idx = process.argv.indexOf("--tasks");
  const n = idx >= 0 ? Number(process.argv[idx + 1] ?? "4") : 4;
  const count = Number.isFinite(n) ? Math.max(1, Math.min(12, Math.floor(n))) : 4;
  return Array.from({ length: count }, (_, i) => `job-${i + 1}`);
}

/** Render one structured pay step as a CLI log line. */
function logStep(s: PayStep): void {
  switch (s.step) {
    case "quote":
      if (!s.ok) console.log(`   quote: ${s.note}`);
      break;
    case "check":
      if (!s.ok) console.log(`   BLOCKED: ${s.note} — no payment attempted.`);
      break;
    case "retry":
      console.log(`   RETRY ${s.attempt}/${s.of} in ${s.waitMs}ms — ${s.note}`);
      break;
    case "pay":
      console.log(s.ok ? `   PAID ${fmtUsd(s.usd ?? 0)}${s.txHash ? ` tx=${s.txHash}` : ""}` : `   FAILED: ${s.note}`);
      break;
    case "result":
      break;
  }
}

async function run() {
  const { address } = agentAccount();
  const perTx = maxPerTxUsd();
  const total = maxTotalUsd();
  const guard = new PaymentGuard({
    account: address,
    maxPerTxUsd: perTx,
    maxTotalUsd: total,
    expectedPayTo: payToAddress(),
  });

  console.log("=== Autonomous paying agent (x402, Base Sepolia) ===");
  if (isMockMode()) console.log(`*** ${MOCK_BANNER}`);
  console.log(`server=${SERVER_URL} network=${NETWORK}`);
  console.log(`account=${address}`);

  const balance = await guard.refreshBalance();
  console.log(`balance: USDC=${fmtUsd(balance)}  (gas is paid by the facilitator, no ETH needed)`);
  console.log(
    `limit: ${fmtUsd(perTx)} per transaction` +
      (total == null
        ? ` (no cumulative cap; paid so far ${fmtUsd(guard.spent())})`
        : ` · cumulative ${fmtUsd(guard.spent())} / ${fmtUsd(total)}`),
  );

  if (balance <= 0) {
    console.log(`\nNo USDC at ${address}.`);
    console.log(`Fund it: https://faucet.circle.com  → USDC → Base Sepolia`);
    console.log(`Track:   ${basescanUrl(address)}`);
  }

  const tasks = parseTasksArg();
  const payer = await buildPayer(guard);
  console.log(`tasks: ${tasks.join(", ")}\n`);

  let paid = 0;
  let blocked = 0;
  let spentThisRun = 0;

  for (const task of tasks) {
    console.log(`-- ${task}: limit=${fmtUsd(guard.perTxLimit)}/tx balance=${fmtUsd(guard.balance)}`);
    const out = await payOnce({ payer, guard, serverUrl: SERVER_URL, task, onStep: logStep });
    if (out.ok) {
      spentThisRun += out.paidUsd ?? 0;
      paid++;
      const summary = (out.data as any)?.result?.summary;
      if (summary) console.log(`   result: ${String(summary).slice(0, 220)}`);
      console.log(`   ledger: ${fmtUsd(guard.spent())} paid in total · balance ${fmtUsd(guard.balance)}`);
    } else {
      blocked++;
    }
  }

  console.log(
    `\n=== Done: paid=${paid} blocked=${blocked} · this run ${fmtUsd(spentThisRun)} · ` +
      `limit ${fmtUsd(perTx)}/tx` +
      (total == null ? ` · lifetime ${fmtUsd(guard.spent())} ===` : ` · cumulative ${fmtUsd(guard.spent())} / ${fmtUsd(total)} ===`),
  );
}

try {
  await run();
} catch (e) {
  failClosed(e);
}
