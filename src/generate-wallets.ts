import "dotenv/config";
import { getAddress } from "viem";
import { failClosed, fmtUsd } from "./config.js";
import { getUsdcBalance } from "./chain.js";
import {
  fundingInstructions,
  hasAgentKey,
  hasSellerKeyVar,
  readEnvVars,
  rotateWallets,
  wouldStrandFunds,
} from "./env-file.js";

/**
 * Create the wallets this project needs, without ever silently orphaning money.
 *
 *   npm run wallets                  fill in only what is missing
 *   npm run wallets -- --force       proceed even if a wallet being replaced holds USDC
 *   npm run wallets -- --rotate-agent  also replace the AGENT wallet (it holds your funds)
 *
 * Two wallets exist:
 *   AGENT  — spends. Fund this one.
 *   SELLER — receives. Its key is saved as SERVER_PRIVATE_KEY, which is what
 *            makes `npm run sweep` able to move earnings back out. An earlier
 *            version discarded that key, and every payment ever made to it is
 *            still sitting at an address nobody can spend from.
 */
async function main() {
  // --force only bypasses the balance guard. Replacing the funded agent wallet
  // is a separate, explicit flag so it can never happen as a side effect.
  const force = process.argv.includes("--force") || process.argv.includes("--fresh");
  const rotateAgent = process.argv.includes("--rotate-agent");
  const vars = readEnvVars();

  const existingAgent = vars.get("AGENT_ADDRESS");
  const existingPayTo = vars.get("SERVER_PAYTO");
  const keepingAgent = hasAgentKey(vars) && !rotateAgent;
  const replacingSeller = rotateAgent || !hasSellerKeyVar(vars);

  // Anything we are about to stop using gets checked for a live balance first.
  const atRiskAddresses: { label: string; address: string; usdc: number }[] = [];
  const check = async (label: string, addr: string | undefined) => {
    if (!addr?.startsWith("0x")) return;
    try {
      atRiskAddresses.push({ label, address: getAddress(addr), usdc: await getUsdcBalance(getAddress(addr)) });
    } catch {
      /* RPC unreachable: do not block wallet creation on a network hiccup */
    }
  };
  if (!keepingAgent) await check("AGENT", existingAgent);
  if (replacingSeller) await check("SELLER (SERVER_PAYTO)", existingPayTo);

  const { blocked, atRisk } = wouldStrandFunds(atRiskAddresses, force);
  if (blocked) {
    // Whether that balance can still be rescued decides what to tell them. A
    // seller created before SERVER_PRIVATE_KEY existed has no key anywhere, so
    // "sweep it first" would be advice that cannot be followed.
    const sellerRecoverable = hasSellerKeyVar(vars);
    console.error("These wallets still hold USDC and would be left behind:\n");
    for (const b of atRisk) console.error(`  ${b.label}  ${b.address}  ${fmtUsd(b.usdc)}`);

    if (sellerRecoverable) {
      console.error("\nRecover it first:  npm run sweep -- --confirm");
      console.error("Or rerun with --force to abandon it.");
    } else {
      console.error("\nThis wallet has no saved private key, so that balance is ALREADY unrecoverable —");
      console.error("it was created before SERVER_PRIVATE_KEY was stored. Nothing can move it, ever.");
      console.error("\nRerun with --force to accept that and create a seller wallet you do control:");
      console.error("  npm run wallets -- --force");
    }
    process.exit(1);
  }

  const res = rotateWallets(vars, "npm run wallets", { rotateAgent });

  console.log("=== x402 Base Sepolia wallets (TESTNET ONLY) ===");
  console.log(res.agentRotated ? "AGENT:  new wallet generated" : "AGENT:  kept (existing key preserved)");
  console.log(res.sellerRotated ? "SELLER: new wallet generated, key saved" : "SELLER: kept");
  console.log("");
  console.log(`AGENT_ADDRESS  = ${res.vars.get("AGENT_ADDRESS")}   <- fund this one`);
  console.log(`SERVER_PAYTO   = ${res.vars.get("SERVER_PAYTO")}   <- receives payments`);
  console.log("SERVER_PRIVATE_KEY saved, so `npm run sweep` can move earnings back out.");

  // A replaced seller means any prior earnings stay at the old address.
  if (res.previousPayTo && res.previousPayTo !== res.vars.get("SERVER_PAYTO")) {
    const left = atRisk.find((b) => b.address.toLowerCase() === res.previousPayTo!.toLowerCase());
    console.log("");
    console.log(`NOTE: payments now go to a different address. The previous one was`);
    console.log(`  ${res.previousPayTo}${left ? `  holding ${fmtUsd(left.usdc)}` : ""}`);
    console.log(`  If that wallet predates SERVER_PRIVATE_KEY, its balance is not recoverable.`);
  }

  console.log("");
  for (const line of fundingInstructions(res.vars.get("AGENT_ADDRESS")!)) console.log(line);
  console.log("");
  console.log("Restart the server after this (`npm run server`) — it reads .env at boot.");
  console.log("Check funding anytime with: npm run balance");
}

main().catch(failClosed);
