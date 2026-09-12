import { createPublicClient, http, formatEther, formatUnits, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { RPC_URL, USDC_ADDRESS, USDC_DECIMALS } from "./config.js";
import { isMockMode, mockStartBalanceUsd } from "./mock.js";

/**
 * On-chain reads, in one place. server.ts, boot.ts, balance.ts and agent.ts
 * previously each carried their own copy of this ABI + RPC setup.
 */

const ERC20_BALANCE_OF = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** EIP-3009: USDC records every authorization nonce it has consumed. */
const AUTHORIZATION_STATE = [
  {
    name: "authorizationState",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});

export type Balances = {
  /** Informational only — see `spendable` below. */
  eth: number;
  usdc: number;
  /**
   * x402's `exact` EVM scheme signs an EIP-3009 transferWithAuthorization
   * off-chain; the FACILITATOR submits the transaction and pays the gas.
   * So the agent needs USDC and needs no ETH at all. Gating on ETH would
   * block a perfectly fundable wallet.
   */
  spendable: boolean;
};

/**
 * A token read that fails must not masquerade as "balance is zero" — that is
 * exactly how a wrong token address went unnoticed here: every read threw, the
 * error was swallowed, and funded wallets were reported as empty. A misread
 * balance is an error; only a successful read of 0 is a zero balance.
 */
export async function getUsdcBalance(address: Address): Promise<number> {
  if (isMockMode()) return await simulatedBalance(address);
  try {
    const raw = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_BALANCE_OF,
      functionName: "balanceOf",
      args: [address],
    });
    return Number(formatUnits(raw as bigint, USDC_DECIMALS));
  } catch (e: any) {
    const code = await publicClient.getCode({ address: USDC_ADDRESS }).catch(() => undefined);
    if (!code || code === "0x") {
      throw new Error(
        `No contract deployed at USDC address ${USDC_ADDRESS} on Base Sepolia. ` +
          `Check USDC_ADDRESS in src/config.ts.`,
      );
    }
    throw new Error(`USDC balanceOf(${address}) failed: ${e?.shortMessage ?? e?.message ?? String(e)}`);
  }
}

export async function getBalances(address: Address): Promise<Balances> {
  if (isMockMode()) {
    const usdc = await simulatedBalance(address);
    return { eth: 0, usdc, spendable: usdc > 0 };
  }
  const [ethWei, usdc] = await Promise.all([
    publicClient.getBalance({ address }),
    getUsdcBalance(address),
  ]);
  return { eth: Number(formatEther(ethWei)), usdc, spendable: usdc > 0 };
}

/**
 * Mock balance = opening float minus what the mock ledger has spent, so it
 * falls as simulated payments settle and the "insufficient balance" branch is
 * reachable without funding anything.
 * Imported dynamically: ledger.ts imports this module, so a static import back
 * would be a cycle. (`require` is not available — this package is ESM.)
 */
async function simulatedBalance(address: Address): Promise<number> {
  const { spentAllTime } = await import("./ledger.js");
  const spent = spentAllTime(address);
  return Math.max(0, Math.round((mockStartBalanceUsd() - spent) * 1e6) / 1e6);
}

/**
 * Did this exact payment actually go through?
 *
 * When a settlement fails with something ambiguous (the facilitator's relayer
 * hitting a nonce collision, a timeout after signing), guessing is not good
 * enough: recording a payment that never happened corrupts the ledger, and
 * discarding one that did hides real spending. USDC's EIP-3009 implementation
 * marks each authorization nonce as used the moment it is consumed, so the
 * chain answers the question directly.
 *
 * true  = the transfer executed; the money moved.
 * false = the authorization was never consumed; no funds moved.
 */
export async function isAuthorizationUsed(authorizer: Address, nonce: `0x${string}`): Promise<boolean> {
  return (await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: AUTHORIZATION_STATE,
    functionName: "authorizationState",
    args: [authorizer, nonce],
  })) as boolean;
}

export function basescanUrl(address: Address): string {
  return `https://sepolia.basescan.org/address/${address}`;
}

export function basescanTx(tx: string): string {
  return `https://sepolia.basescan.org/tx/${tx}`;
}
