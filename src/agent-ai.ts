import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { fmtUsd, maxPerTxUsd, maxTotalUsd, payToAddress, agentAccount } from "./config.js";
import { PaymentGuard } from "./guard.js";
import { buildPayer, payOnce } from "./pay.js";
import { CATALOG, catalogForAgent, serviceById } from "./catalog.js";
import { isMockMode, useOfflineAi } from "./mock.js";

/**
 * The agent that decides what to buy.
 *
 * Claude is given a catalog and a wallet, and loops: pick a service, pay for
 * it, read the result, decide what is next. Every purchase still goes through
 * PaymentGuard, which is unchanged — the model chooses WHAT to buy, the guard
 * decides WHETHER it is allowed.
 *
 * A refusal is a tool RESULT, not an exception. When the guard blocks a
 * purchase (over the per-transaction limit, insufficient balance, wrong asset)
 * the model is told why and gets to adapt: pick something cheaper, or report
 * that the task cannot be done within its means. That only works if the
 * refusal comes back through the normal tool channel.
 */

export const DEFAULT_TASK_BUDGET_USD = 0.08;
const MAX_ITERATIONS = 12;

export type TaskStep =
  | { kind: "tool"; name: string; detail: string }
  | { kind: "purchase"; service: string; usd: number; txHash: string | null; detail: string }
  | { kind: "blocked"; service: string; reason: string; detail: string }
  | { kind: "text"; detail: string };

export type TaskResult = {
  ok: boolean;
  task: string;
  answer: string;
  steps: TaskStep[];
  purchases: Array<{ service: string; usd: number; txHash: string | null }>;
  spentUsd: number;
  budgetUsd: number;
  perTxLimitUsd: number;
  model: string;
  error: string | null;
};

/**
 * Aggregate cap for one task, layered ON TOP of the per-transaction limit.
 *
 * The guard bounds any single payment; this bounds the whole task, which is the
 * limit that actually matters once something can make many small purchases in a
 * loop. Held in memory per task — the durable ledger still records every real
 * payment as it always has.
 */
export class TaskBudget {
  spent = 0;
  constructor(readonly max: number) {}
  get remaining(): number {
    // Rounded to USDC precision like `spent`, or subtraction leaks float drift
    // (0.05 - 0.02 = 0.030000000000000002) into what the agent is told is left.
    return Math.max(0, Math.round((this.max - this.spent) * 1e6) / 1e6);
  }
  affords(usd: number): boolean {
    return usd - this.remaining <= 1e-9;
  }
  record(usd: number): void {
    this.spent = Math.round((this.spent + usd) * 1e6) / 1e6;
  }
}

export function agentModel(): string {
  return process.env.AGENT_MODEL || "claude-opus-5";
}

const SYSTEM_PROMPT = `You are a purchasing agent with your own crypto wallet. You answer the user's
question by buying data from paid APIs, one call at a time.

How to work:
- Call list_services first to see what is for sale and what it costs.
- Buy only what the question actually needs. You are spending real money.
- Every purchase is checked against spending limits you do not control. If a
  purchase is refused, the tool result tells you why — adapt: choose a cheaper
  service, or explain what you could not do and why.
- When you have enough to answer, stop buying and answer.

Answer in plain prose. State what you bought, what it cost, and what it told
you. If limits stopped you from answering fully, say so plainly.`;

/** Build the two tools. Shared by the real loop and the scripted mock. */
function buildTools(ctx: {
  payer: Awaited<ReturnType<typeof buildPayer>>;
  guard: PaymentGuard;
  budget: TaskBudget;
  serverUrl: string;
  steps: TaskStep[];
  purchases: TaskResult["purchases"];
}) {
  const { payer, guard, budget, serverUrl, steps, purchases } = ctx;

  const listServices = betaTool({
    name: "list_services",
    description:
      "List every paid service available, with its price and the parameters it takes. " +
      "Free to call. Also reports how much budget is left for this task.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } as const,
    run: async () => {
      steps.push({ kind: "tool", name: "list_services", detail: `${CATALOG.length} services available` });
      return JSON.stringify({
        services: catalogForAgent(),
        budget: {
          remainingUsd: budget.remaining,
          perTransactionLimitUsd: guard.perTxLimit,
          note: "A single purchase above the per-transaction limit will be refused.",
        },
      });
    },
  });

  const callService = betaTool({
    name: "call_service",
    description:
      "Buy one call to a paid service and return its data. Costs money. " +
      "params_json must be a JSON object matching that service's input schema.",
    inputSchema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "The id of the service, from list_services." },
        params_json: {
          type: "string",
          description: 'JSON object of parameters, e.g. {"symbol":"ETH/USDC"}. Use {} if none.',
        },
      },
      required: ["service_id", "params_json"],
      additionalProperties: false,
    } as const,
    run: async ({ service_id, params_json }) => {
      const service = serviceById(service_id);
      if (!service) {
        steps.push({ kind: "blocked", service: service_id, reason: "unknown-service", detail: "No such service" });
        return JSON.stringify({
          ok: false,
          reason: "unknown-service",
          detail: `No service with id ${service_id}. Call list_services.`,
          valid_ids: CATALOG.map((s) => s.id),
        });
      }

      // Tool inputs are model-generated: always parse, never string-match.
      let params: Record<string, string> = {};
      try {
        const parsed = JSON.parse(params_json || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) params[k] = String(v);
        }
      } catch {
        return JSON.stringify({
          ok: false,
          reason: "bad-params",
          detail: `params_json was not valid JSON: ${String(params_json).slice(0, 80)}`,
        });
      }

      // Task budget first — cheaper to refuse here than to quote and abandon.
      if (!budget.affords(service.priceUsd)) {
        const detail = `${service.id} costs ${fmtUsd(service.priceUsd)} but only ${fmtUsd(budget.remaining)} of the task budget is left`;
        steps.push({ kind: "blocked", service: service.id, reason: "over-task-budget", detail });
        return JSON.stringify({
          ok: false,
          reason: "over-task-budget",
          detail,
          remainingUsd: budget.remaining,
        });
      }

      const result = await payOnce({
        payer,
        guard,
        serverUrl,
        task: service.id,
        path: service.path,
        params,
      });

      if (!result.ok) {
        const reason = result.blockedReason ?? "payment-failed";
        const detail = result.error ?? "payment did not complete";
        steps.push({ kind: "blocked", service: service.id, reason, detail });
        // Refusal returned as data so the model can choose differently.
        return JSON.stringify({
          ok: false,
          reason,
          detail,
          hint:
            reason === "over-per-tx-limit"
              ? `Your per-transaction limit is ${fmtUsd(guard.perTxLimit)}. Choose a cheaper service.`
              : "This purchase did not go through.",
          remainingUsd: budget.remaining,
        });
      }

      const paid = result.paidUsd ?? service.priceUsd;
      budget.record(paid);
      purchases.push({ service: service.id, usd: paid, txHash: result.txHash });
      steps.push({
        kind: "purchase",
        service: service.id,
        usd: paid,
        txHash: result.txHash,
        detail: `Paid ${fmtUsd(paid)} for ${service.id}`,
      });
      return JSON.stringify({
        ok: true,
        service: service.id,
        paidUsd: paid,
        remainingUsd: budget.remaining,
        data: (result.data as any)?.result ?? result.data,
      });
    },
  });

  return [listServices, callService];
}

export async function runTask(opts: {
  task: string;
  budgetUsd?: number;
  serverUrl: string;
}): Promise<TaskResult> {
  const task = opts.task.trim();
  const budget = new TaskBudget(opts.budgetUsd ?? DEFAULT_TASK_BUDGET_USD);
  const steps: TaskStep[] = [];
  const purchases: TaskResult["purchases"] = [];
  const model = agentModel();

  const { address } = agentAccount();
  const guard = new PaymentGuard({
    account: address,
    maxPerTxUsd: maxPerTxUsd(),
    maxTotalUsd: maxTotalUsd(),
    expectedPayTo: payToAddress(),
  });
  await guard.refreshBalance();
  const payer = await buildPayer(guard);

  const base: Omit<TaskResult, "ok" | "answer" | "error"> = {
    task,
    steps,
    purchases,
    spentUsd: 0,
    budgetUsd: budget.max,
    perTxLimitUsd: guard.perTxLimit,
    model: useOfflineAi() ? "scripted-planner" : model,
  };

  const tools = buildTools({ payer, guard, budget, serverUrl: opts.serverUrl, steps, purchases });

  if (useOfflineAi()) {
    // No key, or MOCK_AI set: drive the same tool path with a fixed plan.
    const answer = await runScriptedPlanner(tools, steps);
    return { ...base, ok: true, answer, spentUsd: budget.spent, error: null };
  }

  try {
    const client = new Anthropic();
    const runner = client.beta.messages.toolRunner({
      model,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools,
      messages: [{ role: "user", content: `Task: ${task}` }],
      max_iterations: MAX_ITERATIONS,
    });

    const finalMessage = await runner.done();
    let answer = "";
    for (const block of finalMessage.content) {
      if (block.type === "text") answer += block.text;
    }
    if (answer.trim()) steps.push({ kind: "text", detail: "Answered" });

    return {
      ...base,
      ok: true,
      answer: answer.trim() || "(the agent finished without a written answer)",
      spentUsd: budget.spent,
      error: null,
    };
  } catch (e: any) {
    const msg =
      e instanceof Anthropic.AuthenticationError
        ? "ANTHROPIC_API_KEY was rejected."
        : e instanceof Anthropic.RateLimitError
          ? "Rate limited by the Claude API — retry shortly."
          : e instanceof Anthropic.APIError
            ? `Claude API error ${e.status}: ${e.message}`
            : (e?.message ?? String(e));
    return { ...base, ok: false, answer: "", spentUsd: budget.spent, error: msg };
  }
}

/**
 * MOCK_AI: a fixed decision sequence instead of a model.
 *
 * It calls the same tool functions in the same order a sensible agent would —
 * survey, then buy the two cheapest — so the payment path, the guard, the task
 * budget and the step log are all genuinely exercised with no API key and no
 * token spend.
 */
async function runScriptedPlanner(tools: ReturnType<typeof buildTools>, steps: TaskStep[]): Promise<string> {
  const [list, call] = tools as any[];
  await list.run({});
  const cheapest = [...CATALOG].sort((a, b) => a.priceUsd - b.priceUsd).slice(0, 2);
  const seen: string[] = [];
  for (const svc of cheapest) {
    const sample: Record<string, string> = {};
    for (const key of svc.input.required) {
      sample[key] = key === "symbol" ? "ETH/USDC" : key === "task" ? svc.id : "demo";
    }
    const raw = await call.run({ service_id: svc.id, params_json: JSON.stringify(sample) });
    const parsed = JSON.parse(raw);
    seen.push(parsed.ok ? `${svc.id} (${fmtUsd(parsed.paidUsd)})` : `${svc.id} refused: ${parsed.reason}`);
  }
  steps.push({ kind: "text", detail: "Answered (scripted)" });
  return `[scripted planner — no model was called] Bought the two cheapest services: ${seen.join(", ")}. Set ANTHROPIC_API_KEY and drop MOCK_AI to have Claude decide instead.`;
}
