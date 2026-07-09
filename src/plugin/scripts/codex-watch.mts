#!/usr/bin/env node
import { runCodexWatcher } from "./lib/codex-flow.mjs";

const sessionKey = process.argv[2] ?? "";
const settlementId = process.argv[3] ?? "";

main().catch(() => {
  process.exitCode = 0;
});

async function main(): Promise<void> {
  if (!/^[a-f0-9]{24}$/.test(sessionKey)) return;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(settlementId)) return;
  if (process.send && process.connected) process.send({ type: "ready" }, () => undefined);
  if (process.connected) process.disconnect();
  await runCodexWatcher(sessionKey, settlementId);
}
