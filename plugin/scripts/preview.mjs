#!/usr/bin/env node
import { loadState } from "./lib/state.mjs";

const state = await loadState();

if (!state.lastPayload) {
  console.log("No report payload has been uploaded yet.");
  process.exit(0);
}

console.log(JSON.stringify({
  lastReportAt: state.lastReportAt,
  payload: state.lastPayload
}, null, 2));
