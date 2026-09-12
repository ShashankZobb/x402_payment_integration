import "dotenv/config";
import { failClosed, fmtUsd } from "./config.js";
import { DEFAULT_TASK_BUDGET_USD, runTask } from "./agent-ai.js";
import { MOCK_BANNER, isMockAi, isMockMode } from "./mock.js";

/**
 * npm run task -- "what's the sentiment on ETH?" [--budget 0.05]
 *
 * Requires the seller to be running (npm run server), since the agent buys from it.
 */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const budgetFlag = flag("--budget");
  // Drop a flag's value if it was swept up as positional text.
  const task = args.filter((a) => a !== budgetFlag).join(" ").trim();
  if (!task) {
    console.error('Usage: npm run task -- "your question here" [--budget 0.05]');
    process.exit(1);
  }
  const budgetUsd = budgetFlag ? Number(budgetFlag) : DEFAULT_TASK_BUDGET_USD;
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    console.error(`--budget must be a positive number, got ${JSON.stringify(budgetFlag)}`);
    process.exit(1);
  }

  const serverUrl = process.env.SERVER_URL ?? "http://localhost:4021";
  if (isMockMode() || isMockAi()) {
    console.log(`*** ${isMockMode() ? MOCK_BANNER : "MOCK_AI: scripted planner, no tokens spent."}`);
  }
  console.log(`\ntask: ${task}`);
  console.log(`budget: ${fmtUsd(budgetUsd)}\n`);

  const r = await runTask({ task, budgetUsd, serverUrl });

  for (const s of r.steps) {
    if (s.kind === "tool") console.log(`  ·  ${s.name}: ${s.detail}`);
    else if (s.kind === "purchase") console.log(`  $  ${s.detail}${s.txHash ? ` tx=${s.txHash}` : ""}`);
    else if (s.kind === "blocked") console.log(`  x  BLOCKED [${s.reason}] ${s.detail}`);
  }

  console.log(`\nmodel: ${r.model}`);
  console.log(`spent: ${fmtUsd(r.spentUsd)} of ${fmtUsd(r.budgetUsd)} (limit ${fmtUsd(r.perTxLimitUsd)}/tx)`);
  if (r.error) {
    console.error(`\n${r.error}`);
    process.exit(1);
  }
  console.log(`\n${r.answer}\n`);
}

main().catch(failClosed);
