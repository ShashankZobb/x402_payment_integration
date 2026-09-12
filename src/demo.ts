import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { agentAccount, failClosed } from "./config.js";
import { PROJECT_ROOT, fundingInstructions } from "./env-file.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4021";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn without a shell so the returned handle is the actual node process.
 * With `shell: true` on Windows, kill() terminates the intermediate cmd.exe
 * and leaves tsx running — which used to leave port 4021 occupied and make
 * the next `npm run demo` fail.
 */
function spawnNode(script: string, args: string[] = []): ChildProcess {
  return spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", script, ...args], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: process.env,
  });
}

async function waitForServer(url: string, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* retry */
    }
    await delay(750);
  }
  return false;
}

async function main() {
  const { address } = agentAccount();
  console.log("=== x402 full demo: server + dashboard + agent ===");
  for (const line of fundingInstructions(address)) console.log(line);
  console.log("");

  const server = spawnNode("src/server.ts");
  let stopped = false;
  const stopServer = () => {
    if (!stopped) {
      stopped = true;
      server.kill();
    }
  };
  process.on("SIGINT", stopServer);
  process.on("SIGTERM", stopServer);
  process.on("exit", stopServer);

  // /health is free, so this poll costs nothing and needs no wallet.
  if (!(await waitForServer(`${SERVER_URL}/health`))) {
    console.error("Server did not start on :4021. Is the port busy? Kill old node first.");
    stopServer();
    process.exit(1);
  }
  console.log(`Server UP: ${SERVER_URL}/dashboard`);

  const i = process.argv.indexOf("--tasks");
  const tasks = i >= 0 ? String(process.argv[i + 1] ?? "6") : "6";
  const agent = spawnNode("src/agent.ts", ["--tasks", tasks]);
  const code = await new Promise<number>((resolve) => agent.on("exit", (c) => resolve(c ?? 0)));

  console.log(`\nAgent finished (exit ${code}). Stopping server.`);
  stopServer();
}

main().catch(failClosed);
