import "dotenv/config";
import { createWalletClient, http, getAddress, parseUnits, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  RPC_URL,
  USDC_ADDRESS,
  USDC_DECIMALS,
  agentAccount,
  failClosed,
  fmtUsd,
  sellerAccount,
} from "./config.js";
import { basescanTx, basescanUrl, getUsdcBalance, publicClient } from "./chain.js";
import { isMockMode, MOCK_BANNER } from "./mock.js";

/**
 * Move USDC out of the seller wallet.
 *
 *   npm run sweep                     dry run — show what would move
 *   npm run sweep -- --confirm        actually send
 *   npm run sweep -- --to 0xabc…      somewhere other than the agent wallet
 *
 * Gas: this is an ordinary ERC-20 transfer, so the SELLER pays for it in ETH.
 * The x402 facilitator only covers gas for its own EIP-3009 settlement flow —
 * it will not relay this. A wallet that has only ever received x402 payments
 * therefore has zero ETH and needs a one-time faucet top-up before it can
 * send anything out.
 */

const ERC20_TRANSFER = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function flagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  if (isMockMode()) console.log(`*** ${MOCK_BANNER}\n`);

  const seller = sellerAccount(); // throws with guidance when no key is saved

  const toRaw = flagValue("--to");
  let destination: Address;
  try {
    destination = toRaw ? getAddress(toRaw) : agentAccount().address;
  } catch {
    console.error(`Invalid --to address: ${JSON.stringify(toRaw)}`);
    process.exit(1);
  }
  if (destination === seller.address) {
    console.error("Destination is the seller wallet itself — nothing to do.");
    process.exit(1);
  }

  console.log("=== Sweep seller earnings ===");
  console.log(`from  ${seller.address}  (SERVER_PAYTO)`);
  console.log(`to    ${destination}`);

  if (isMockMode()) {
    console.log("\nMock mode: no chain call made. Run without MOCK_PAYMENTS to sweep for real.");
    return;
  }

  const [usdc, ethWei] = await Promise.all([
    getUsdcBalance(seller.address),
    publicClient.getBalance({ address: seller.address }),
  ]);
  console.log(`\nUSDC available : ${fmtUsd(usdc)}`);
  console.log(`ETH for gas    : ${Number(ethWei) / 1e18}`);

  if (usdc <= 0) {
    console.log("\nNothing to sweep.");
    return;
  }

  // The expected first-run state: earnings arrived via x402 (facilitator paid
  // the gas), so this wallet has never needed ETH and has none.
  if (ethWei === 0n) {
    console.log("\nCannot send: this wallet has no ETH, and an ERC-20 transfer costs gas.");
    console.log("The x402 facilitator pays gas only for payment settlement, not for transfers out.");
    console.log("\nSend a little Base Sepolia ETH here, then rerun:");
    console.log(`  ${seller.address}`);
    console.log("  https://docs.base.org/docs/tools/network-faucets  (a few cents' worth is plenty)");
    console.log(`  ${basescanUrl(seller.address)}`);
    process.exit(1);
  }

  if (!confirm) {
    console.log(`\nDRY RUN — would transfer ${fmtUsd(usdc)} USDC to ${destination}.`);
    console.log("Rerun with --confirm to send it.");
    return;
  }

  const walletClient = createWalletClient({
    account: privateKeyToAccount(seller.privateKey),
    chain: baseSepolia,
    transport: http(RPC_URL),
  });
  const amount = parseUnits(usdc.toFixed(USDC_DECIMALS), USDC_DECIMALS);

  console.log(`\nSending ${fmtUsd(usdc)} …`);
  const hash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_TRANSFER,
    functionName: "transfer",
    args: [destination, amount],
  });
  console.log(`tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`status: ${receipt.status}`);
  console.log(basescanTx(hash));

  if (receipt.status === "success") {
    console.log(`\nSwept. Seller now holds ${fmtUsd(await getUsdcBalance(seller.address))}.`);
  } else {
    console.error("\nTransaction reverted — nothing moved.");
    process.exit(1);
  }
}

main().catch(failClosed);
