#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { PLUGIN_ID } from "../shared/site-config.mjs";

const sessionId = getSessionIdArg();

if (!sessionId) {
  console.error("Usage: node scripts/diagnose-session.mjs <session-id> [--debug-log <path>] [--transcript <path>]");
  process.exit(1);
}

const debugLogPath = getArgValue("--debug-log") || getDefaultDebugLogPath();
const transcriptPath = getArgValue("--transcript") || await findTranscriptPath(sessionId);
const sessionKey = hashLocalSessionId(sessionId);
const debugRecords = await readJsonl(debugLogPath);
const sessionDebugRecords = debugRecords.filter((record) => record?.sessionKey === sessionKey);
const transcriptRecords = transcriptPath ? await readJsonl(transcriptPath) : [];
const transcriptSessionRecords = transcriptRecords.filter((record) => !record?.sessionId || record.sessionId === sessionId);

console.log(`session: ${sessionId}`);
console.log(`sessionKey: ${sessionKey}`);
console.log(`debugLog: ${debugLogPath}${sessionDebugRecords.length === 0 ? " (no records for this session)" : ""}`);
console.log(`transcript: ${transcriptPath || "(not found)"}`);
console.log("");

printHookEvents(sessionDebugRecords);
printTranscriptTimeline(transcriptSessionRecords);

function printHookEvents(records) {
  console.log("hook events:");
  if (records.length === 0) {
    console.log("  missing: ROUTER_VITALS_DEBUG_HOOK was not enabled, so hook stdin evidence is unavailable");
    console.log("");
    return;
  }

  for (const record of records) {
    console.log(`  ${record.at} ${record.eventName} ${record.stage}`);
    if (record.stage === "received") {
      const input = record.data?.input || {};
      console.log(`    input keys: ${formatList(input.keys || [])}`);
      console.log(`    transcript: ${input.transcriptPath ? "present" : "missing"}`);
      console.log(`    error: ${input.errorType || "unknown"} status=${input.errorStatusCode ?? "null"} hint=${input.errorHint ? `"${input.errorHint}"` : "null"}`);
      printModelEvidence("input model evidence", {
        modelClass: input.directInputModelClass || "unknown",
        candidates: input.modelCandidates || []
      });
      continue;
    }

    if (record.stage === "prompt_start") {
      console.log(`    target matched: ${record.data?.targetMatched === true}`);
      console.log(`    transcript start offset: ${record.data?.transcriptStartOffset ?? "null"}`);
      console.log(`    pending after: ${formatTurn(record.data?.pendingAfter)}`);
      console.log(`    session before: ${formatTurn(record.data?.sessionBefore)} after=${formatTurn(record.data?.sessionAfter)}`);
      printModelEvidence("model resolution", {
        modelClass: record.data?.promptModelClass || "unknown",
        source: record.data?.promptSource || "unknown",
        direct: record.data?.directInputModelClass || "unknown"
      });
      for (const output of record.data?.promptTranscript?.modelSetOutputs || []) {
        console.log(`    local command output: parsedModel=${output.modelClass} ansi=${output.hasAnsi} text="${output.textPreview}"`);
      }
      continue;
    }

    if (record.stage === "completion") {
      const resolution = record.data?.modelResolution || {};
      console.log(`    skipped: ${record.data?.skipped || "no"}`);
      console.log(`    pending: ${formatTurn(record.data?.pending)}`);
      if (record.data?.payload) {
        const payload = record.data.payload;
        console.log(`    payload: ok=${payload.ok} model=${payload.modelClass} error=${payload.errorType} status=${payload.errorStatusCode ?? "null"} target=${payload.targetHost || "unknown"} posted=${record.data?.posted ?? "unknown"}`);
        if (record.data?.postResult) {
          console.log(`    post result: ${formatPostResult(record.data.postResult)}`);
        }
      }
      printModelEvidence("model resolution", {
        modelClass: resolution.modelClass || "unknown",
        source: resolution.source || "unknown",
        direct: resolution.directInputModelClass || "unknown",
        transcript: resolution.transcriptModelClass || "unknown",
        fallbacks: resolution.fallbackModelClasses || []
      });
      for (const observation of record.data?.transcript?.modelObservations || []) {
        console.log(`    transcript observation: type=${observation.recordType || "unknown"} model=${observation.modelClass}`);
        printCandidates("candidates", observation.candidates || [], "      ");
      }
      continue;
    }

    if (record.stage === "session_start") {
      console.log(`    session after: ${formatTurn(record.data?.sessionAfter)}`);
      printModelEvidence("model resolution", { modelClass: record.data?.modelClass || "unknown", source: "session_start" });
      continue;
    }

    if (record.stage === "session_end") {
      console.log(`    session after: ${formatTurn(record.data?.sessionAfter)}`);
    }
  }
  console.log("");
}

function printTranscriptTimeline(records) {
  console.log("transcript timeline:");
  if (records.length === 0) {
    console.log("  missing or empty");
    return;
  }

  let count = 0;
  for (const record of records) {
    const summary = summarizeTranscriptRecord(record);
    if (!summary) continue;
    count += 1;
    console.log(`  ${summary.timestamp} ${summary.kind}`);
    for (const detail of summary.details) console.log(`    ${detail}`);

    if (summary.candidates.length > 0) {
      printCandidates("model fields", summary.candidates, "    ");
    }
  }

  if (count === 0) console.log("  no diagnostic transcript records found");
}

function summarizeTranscriptRecord(record) {
  const timestamp = record.timestamp || "(no timestamp)";
  const candidates = collectModelCandidates(record, "record");
  const output = inspectModelSetOutput(record);
  const details = [];

  if (output) {
    details.push(`stdout: rawModel=${output.rawModel} strippedModel=${output.ansiStrippedModel} ansi=${output.hasAnsi}`);
    details.push(`text="${output.textPreview}"`);
    return {
      timestamp,
      kind: "local_command_stdout",
      details,
      candidates
    };
  }

  if (record?.type === "system" && record?.subtype === "api_error") {
    details.push(`status=${record.error?.status ?? "unknown"} formatted="${previewText(String(record.error?.formatted || record.error?.message || ""))}"`);
    details.push(`retry=${record.retryAttempt ?? "unknown"}/${record.maxRetries ?? "unknown"}`);
    return {
      timestamp,
      kind: "api_error",
      details,
      candidates
    };
  }

  if (record?.type === "assistant" && (record.isApiErrorMessage || record.apiErrorStatus)) {
    details.push(`synthetic=${record.message?.model === "<synthetic>"} status=${record.apiErrorStatus ?? "unknown"}`);
    return {
      timestamp,
      kind: "assistant_error",
      details,
      candidates
    };
  }

  if (record?.type === "system" && record?.subtype === "turn_duration") {
    details.push(`durationMs=${record.durationMs ?? "unknown"} messageCount=${record.messageCount ?? "unknown"}`);
    return {
      timestamp,
      kind: "turn_duration",
      details,
      candidates
    };
  }

  if (candidates.length > 0) {
    details.push(`recordType=${formatRecordType(record)}`);
    return {
      timestamp,
      kind: "model_fields",
      details,
      candidates
    };
  }

  return null;
}

function printModelEvidence(label, evidence, indent = "    ") {
  const parts = [`class=${evidence.modelClass || "unknown"}`];
  if (evidence.source) parts.push(`source=${evidence.source}`);
  if (evidence.direct) parts.push(`direct=${evidence.direct}`);
  if (evidence.transcript) parts.push(`transcript=${evidence.transcript}`);
  if (evidence.fallbacks) parts.push(`fallbacks=${JSON.stringify(evidence.fallbacks)}`);
  console.log(`${indent}${label}: ${parts.join(" ")}`);
  if (evidence.candidates) printCandidates("candidates", evidence.candidates, `${indent}  `);
}

function formatList(values) {
  return Array.isArray(values) && values.length > 0 ? values.join(",") : "none";
}

function inspectModelSetOutput(record) {
  if (!record || typeof record !== "object") return null;
  const content = typeof record.content === "string"
    ? record.content
    : typeof record.message?.content === "string"
      ? record.message.content
      : null;
  if (!content || !content.toLowerCase().includes("<local-command-stdout>")) return null;
  if (!/(?:^|[>\r\n])\s*set\s+model\s+to\b/i.test(content)) return null;

  return {
    rawModel: parseModelSetOutput(content),
    ansiStrippedModel: parseModelSetOutput(stripAnsiControlSequences(content)),
    hasAnsi: hasAnsiControlSequence(content),
    textPreview: previewText(content)
  };
}

function parseModelSetOutput(text) {
  const match = text.match(/(?:^|[>\r\n])\s*set\s+model\s+to\s+(fable|opus|sonnet|haiku)\b/i);
  return match ? match[1].toLowerCase() : "unknown";
}

function collectModelCandidates(value, prefix) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();

  collectModelCandidatesFromRecord(value, prefix, result, seen);
  for (const key of ["message", "request", "response", "error"]) {
    const child = value[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      collectModelCandidatesFromRecord(child, `${prefix}.${key}`, result, seen);
    }
  }

  return result;
}

function collectModelCandidatesFromRecord(value, prefix, result, seen) {
  addModelCandidate(result, seen, `${prefix}.model`, value.model);
  addModelCandidate(result, seen, `${prefix}.model_id`, value.model_id);
  addModelCandidate(result, seen, `${prefix}.model_name`, value.model_name);

  const nestedModel = value.model && typeof value.model === "object" && !Array.isArray(value.model) ? value.model : null;
  if (nestedModel) {
    addModelCandidate(result, seen, `${prefix}.model.id`, nestedModel.id);
    addModelCandidate(result, seen, `${prefix}.model.name`, nestedModel.name);
    addModelCandidate(result, seen, `${prefix}.model.display_name`, nestedModel.display_name);
    addModelCandidate(result, seen, `${prefix}.model.displayName`, nestedModel.displayName);
  }
}

function addModelCandidate(result, seen, path, value) {
  if (typeof value !== "string" || value.trim() === "" || seen.has(path)) return;
  seen.add(path);
  result.push({
    path,
    value: previewText(value),
    modelClass: classifyModelText(value)
  });
}

function printCandidates(label, candidates, indent = "    ") {
  if (candidates.length === 0) {
    console.log(`${indent}${label}: none`);
    return;
  }
  console.log(`${indent}${label}:`);
  for (const candidate of candidates) {
    console.log(`${indent}  ${candidate.path}="${candidate.value}" class=${candidate.modelClass}`);
  }
}

async function readJsonl(path) {
  if (!path || !existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function findTranscriptPath(id) {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  const targetName = `${id}.jsonl`;
  return findFile(root, targetName);
}

async function findFile(root, targetName) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && basename(path) === targetName) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, targetName);
      if (found) return found;
    }
  }

  return null;
}

function getDefaultDebugLogPath() {
  return join(getStateRoot(), PLUGIN_ID, "debug-hook.jsonl");
}

function getStateRoot() {
  return (
    process.env.ROUTER_VITALS_STATE_DIR ||
    process.env.XDG_STATE_HOME ||
    process.env.LOCALAPPDATA ||
    process.env.APPDATA ||
    join(homedir(), ".local", "state")
  );
}

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function getSessionIdArg() {
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--debug-log" || arg === "--transcript") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) return arg;
  }
  return null;
}

function hashLocalSessionId(id) {
  if (typeof id !== "string" || id.length === 0) return "default";
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

function classifyModelText(value) {
  const lower = value.toLowerCase();
  if (lower.includes("fable")) return "fable";
  if (lower.includes("haiku")) return "haiku";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("opus")) return "opus";
  return "unknown";
}

function stripAnsiControlSequences(value) {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function hasAnsiControlSequence(value) {
  return /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/.test(value);
}

function previewText(value) {
  return value
    .replace(/\x1B/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .slice(0, 240);
}

function formatTurn(turn) {
  if (!turn) return "none";
  return JSON.stringify(turn);
}

function formatPostResult(result) {
  if (!result || typeof result !== "object") return "unknown";
  if (result.ok === true) return `ok status=${result.statusCode ?? "unknown"}`;
  const parts = [`failed reason=${result.reason || "unknown"}`];
  if (result.statusCode) parts.push(`status=${result.statusCode}`);
  return parts.join(" ");
}

function formatRecordType(record) {
  return [record.type, record.subtype].filter(Boolean).join(":") || "unknown";
}
