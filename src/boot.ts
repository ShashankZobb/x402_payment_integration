import "dotenv/config";
import { spawn } from "node:child_process";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fmtUsd, maxPerTxUsd, maxTotalUsd, failClosed } from "./config.js";
import { basescanUrl, getBalances } from "./chain.js";
import { PROJECT_ROOT, fundingInstructions, hasWallets, readEnvVars, rotateWallets } from "./env-file.js";
import { spentAllTime } from "./ledger.js";

// npm run boot [-- --fresh] [--min-usdc 1]
// 1) ensures .env wallets exist (generates ONLY if missing, unless --fresh)
// 2) logs the USDC balance for the active AGENT_ADDRESS
// 3) starts the server only if the wallet can actually pay.

/**
 * Flag parsing that tolerates a missing flag. The previous version did
 * `argv[argv.indexOf("--min-eth") + 1]`, and indexOf returns -1 when absent,
 * so it read argv[0] — meaning `npm run boot -- --fresh` produced
 * minEth = Number("--fresh") = NaN and every threshold comparison was false,
 * making boot report NOT FUNDED no matter how much the wallet held.
 */
function flagNumber(argv: string[], flag: string, fallback: number): number {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`[boot] ${flag} needs a finite non-negative number, got ${JSON.stringify(argv[i + 1])}`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const argv = process.argv.slice(2);
  const fresh = argv.includes("--fresh");
  const minUsdc = flagNumber(argv, "--min-usdc", 0);

  let vars = readEnvVars();
  if (hasWallets(vars) && !fresh) {
    console.log("[boot] reusing wallets already in .env (use --fresh to rotate).");
  } else if (fresh) {
    // Rotating can orphan funds, and the checks live in one place. Send the
    // user through it rather than reimplementing the guard here.
    console.error("[boot] --fresh no longer rotates wallets directly, because that can strand funds.");
    console.error("[boot] Run `npm run wallets -- --force` instead; it refuses if a wallet still holds USDC.");
    process.exit(1);
  } else {
    console.log("[boot] no wallets in .env: generating…");
    const res = rotateWallets(vars, "npm run boot");
    vars = res.vars;
    console.log(`[boot] AGENT_ADDRESS=${vars.get("AGENT_ADDRESS")}`);
    console.log(`[boot] SERVER_PAYTO=${vars.get("SERVER_PAYTO")}`);
  }

  const agentAddr = getAddress(
    vars.get("AGENT_ADDRESS") ?? privateKeyToAccount(vars.get("AGENT_PRIVATE_KEY") as `0x${string}`).address,
  );

  console.log(`[boot] checking balance for ${agentAddr} …`);
  const { eth, usdc } = await getBalances(agentAddr);
  // Only USDC gates startup: the facilitator submits the EIP-3009 transfer and
  // pays the gas, so an ETH balance of zero is perfectly normal here.
  console.log(`[boot] balance → USDC=${usdc} (need > ${minUsdc})   ETH=${eth} (informational, not required)`);
  const total = maxTotalUsd();
  console.log(
    `[boot] limit   → ${fmtUsd(maxPerTxUsd())} per transaction, paid so far ${fmtUsd(spentAllTime(agentAddr))}` +
      (total == null ? " (no cumulative cap)" : ` of ${fmtUsd(total)}`),
  );
  console.log(`[boot] track: ${basescanUrl(agentAddr)}`);

  if (!(usdc > minUsdc)) {
    console.log("");
    console.log("[boot] NOT FUNDED — server will NOT start (would only serve 402 rejections).");
    for (const line of fundingInstructions(agentAddr)) console.log(`[boot] ${line}`);
    console.log("[boot] then rerun: npm run boot   (no --fresh, or you orphan the funds!)");
    process.exit(1);
  }

  console.log("[boot] FUNDED ✔ — starting server (dashboard: http://localhost:4021/dashboard) …");
  const child = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch(failClosed);
