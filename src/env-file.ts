import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEFAULT_MAX_PER_TX_USD, USDC_ADDRESS } from "./config.js";

/**
 * .env read/write, shared by `npm run wallets` and `npm run boot`
 * (which previously carried two near-identical copies that had already
 * drifted apart in their defaults).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, ".env.example");

const ORDER = [
  "PORT",
  "SERVER_URL",
  "FACILITATOR_URL",
  "SERVER_PAYTO",
  "SERVER_ADDRESS",
  "SERVER_PRIVATE_KEY",
  "AGENT_PRIVATE_KEY",
  "AGENT_ADDRESS",
  "MAX_PER_TX_USD",
  "MAX_TOTAL_USD",
  "PRICE_PER_CALL",
];

const DEFAULTS: Record<string, string> = {
  PORT: "4021",
  SERVER_URL: "http://localhost:4021",
  FACILITATOR_URL: "https://x402.org/facilitator",
  MAX_PER_TX_USD: String(DEFAULT_MAX_PER_TX_USD),
  PRICE_PER_CALL: "$0.01",
};

export function parseEnv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    map.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  return map;
}

export function readEnvVars(): Map<string, string> {
  let base = "";
  if (fs.existsSync(ENV_PATH)) base = fs.readFileSync(ENV_PATH, "utf8");
  else if (fs.existsSync(ENV_EXAMPLE_PATH)) base = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");
  return parseEnv(base);
}

export function hasWallets(vars: Map<string, string>): boolean {
  return !!vars.get("AGENT_PRIVATE_KEY")?.startsWith("0x") && !!vars.get("SERVER_PAYTO")?.startsWith("0x");
}

/** Does this .env already hold a spendable key for each role? */
export function hasAgentKey(vars: Map<string, string>): boolean {
  return !!vars.get("AGENT_PRIVATE_KEY")?.startsWith("0x");
}
export function hasSellerKeyVar(vars: Map<string, string>): boolean {
  return !!vars.get("SERVER_PRIVATE_KEY")?.startsWith("0x");
}

export type RotateResult = {
  vars: Map<string, string>;
  agentRotated: boolean;
  sellerRotated: boolean;
  /** payTo before this call, when the seller was replaced — funds may sit there. */
  previousPayTo?: string;
};

/**
 * Write whatever wallets are missing, and by default leave existing ones alone.
 *
 * The original version always regenerated both. That silently replaced a funded
 * SERVER_PAYTO, and since the seller key was discarded the balance at the old
 * address became unspendable forever. Preserving existing keys is the default
 * now; replacing them is opt-in via `force`.
 */
export function rotateWallets(
  vars: Map<string, string>,
  writtenBy: string,
  opts: { rotateAgent?: boolean; rotateSeller?: boolean } = {},
): RotateResult {
  const previousPayTo = vars.get("SERVER_PAYTO");

  // Replacing the agent is its own decision: it is the funded wallet, and
  // conflating it with "proceed anyway" would throw away the user's balance as
  // a side effect of an unrelated flag.
  const agentRotated = opts.rotateAgent === true || !hasAgentKey(vars);
  // A seller with no saved key cannot be swept, so it is replaced by default;
  // the caller warns about the old address before this runs.
  const sellerRotated = opts.rotateSeller === true || !hasSellerKeyVar(vars);

  if (agentRotated) {
    const agentKey = generatePrivateKey();
    const agent = privateKeyToAccount(agentKey);
    vars.set("AGENT_PRIVATE_KEY", agentKey);
    vars.set("AGENT_ADDRESS", agent.address);
    process.env.AGENT_PRIVATE_KEY = agentKey;
    process.env.AGENT_ADDRESS = agent.address;
  }

  if (sellerRotated) {
    const serverKey = generatePrivateKey();
    const server = privateKeyToAccount(serverKey);
    // Persisting this is the whole point: without it, earnings are unspendable.
    vars.set("SERVER_PRIVATE_KEY", serverKey);
    vars.set("SERVER_PAYTO", server.address);
    vars.set("SERVER_ADDRESS", server.address);
    process.env.SERVER_PRIVATE_KEY = serverKey;
    process.env.SERVER_PAYTO = server.address;
    process.env.SERVER_ADDRESS = server.address;
  }

  for (const [k, v] of Object.entries(DEFAULTS)) if (!vars.has(k)) vars.set(k, v);
  writeEnv(vars, writtenBy);

  return {
    vars,
    agentRotated,
    sellerRotated,
    ...(sellerRotated && previousPayTo ? { previousPayTo } : {}),
  };
}

/**
 * Should a rotation be refused because live funds would be left behind?
 * Pure so it can be asserted without touching the chain.
 */
export function wouldStrandFunds(
  balances: { label: string; address: string; usdc: number }[],
  force: boolean,
): { blocked: boolean; atRisk: { label: string; address: string; usdc: number }[] } {
  const atRisk = balances.filter((b) => b.usdc > 0);
  return { blocked: atRisk.length > 0 && !force, atRisk };
}

export function writeEnv(vars: Map<string, string>, writtenBy: string): void {
  const lines = [`# x402 demo (DO NOT commit real mainnet keys; testnet only) - auto-written by \`${writtenBy}\``];
  for (const k of ORDER) if (vars.has(k)) lines.push(`${k}=${vars.get(k)}`);
  for (const [k, v] of vars) if (!ORDER.includes(k)) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
}

export function fundingInstructions(agentAddress: string): string[] {
  return [
    `Fund the AGENT address: ${agentAddress}`,
    `  USDC (this is what gets spent): https://faucet.circle.com → USDC → Base Sepolia`,
    `  USDC contract: ${USDC_ADDRESS}`,
    `  No ETH needed — the x402 facilitator submits the transaction and pays the gas.`,
  ];
}
