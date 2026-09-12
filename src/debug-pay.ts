import "dotenv/config";
import axios from "axios";
import { withPaymentInterceptor, createSigner } from "x402-axios";
import { NETWORK, agentAccount, failClosed, fmtUsd, maxPerTxUsd, maxTotalUsd, payToAddress } from "./config.js";
import { PaymentGuard, findBlocked } from "./guard.js";

/**
 * Manual single-payment debug helper.
 *
 * It goes through PaymentGuard like the agent does. A debug script that paid
 * without the guard would be an unguarded spend path sitting in the repo,
 * which defeats the point of having a cap at all.
 */
async function main() {
  const { address, privateKey } = agentAccount();
  const guard = new PaymentGuard({
    account: address,
    maxPerTxUsd: maxPerTxUsd(),
    maxTotalUsd: maxTotalUsd(),
    expectedPayTo: payToAddress(),
  });

  const signer: any = await (createSigner as any)(NETWORK, privateKey);
  console.log("signer addr:", signer?.account?.address ?? signer?.address ?? "unknown");
  console.log("account     :", address);
  console.log("balance     :", fmtUsd(await guard.refreshBalance()));
  console.log("limit       :", `${fmtUsd(guard.perTxLimit)} per transaction`);

  guard.beginTask("debug");
  const client: any = withPaymentInterceptor(axios.create({ timeout: 120_000 }) as any, signer, guard.select as any);

  try {
    const r = await client.get("http://localhost:4021/premium", { params: { task: "debug" } });
    const tx = (r.headers as any)?.["x-payment-response"] ? "(see PAYMENT-RESPONSE header)" : undefined;
    guard.settled();
    console.log("OK", JSON.stringify(r.data).slice(0, 300), tx ?? "");
  } catch (e: any) {
    const blocked = findBlocked(e);
    if (blocked) {
      guard.failed(true);
      console.log(`BLOCKED [${blocked.reason}] ${blocked.detail}`);
      return;
    }
    guard.failed(false);
    console.log("FAIL msg:", e?.message);
    console.log("FAIL status:", e?.response?.status);
    console.log("FAIL data:", JSON.stringify(e?.response?.data ?? e?.cause ?? "").slice(0, 800));
  }
}

main().catch(failClosed);
