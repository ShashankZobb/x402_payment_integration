import "dotenv/config";
import { getAddress } from "viem";
import { agentAccount, failClosed, fmtUsd, maxPerTxUsd, maxTotalUsd } from "./config.js";
import { basescanUrl, getBalances } from "./chain.js";
import { spentAllTime } from "./ledger.js";

/**
 * Balance + budget for the linked account.
 * The address comes from .env's AGENT_PRIVATE_KEY — there is no hardcoded
 * fallback any more, because the stale literal that used to live here pointed
 * at a wallet that had long since been rotated out.
 * One-off override: npm run balance -- 0xabc…
 */
try {
  const override = process.argv[2];
  const addr = override ? getAddress(override) : agentAccount().address;
  console.log(`account ${addr}  (from ${override ? "CLI arg" : ".env AGENT_PRIVATE_KEY"})`);

  const { eth, usdc } = await getBalances(addr);
  console.log(`  USDC  ${usdc}   ← this is what pays for calls`);
  console.log(`  ETH   ${eth}   ← not required; the facilitator pays settlement gas`);

  const perTx = maxPerTxUsd();
  const total = maxTotalUsd();
  const spent = spentAllTime(addr);
  console.log(`  limit ${fmtUsd(perTx)} per transaction   ← max size of any single payment`);
  console.log(
    total == null
      ? `  total ${fmtUsd(spent)} paid so far (no cumulative cap set)`
      : `  total ${fmtUsd(spent)} / ${fmtUsd(total)} → ${fmtUsd(Math.max(0, total - spent))} left`,
  );
  console.log(`  ${basescanUrl(addr)}`);
} catch (e) {
  failClosed(e);
}
