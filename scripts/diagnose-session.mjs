#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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

printDebugSummary(sessionDebugRecords);
printTranscriptSummary(transcriptSessionRecords);

function printDebugSummary(records) {
  console.log("hook debug:");
  if (records.length === 0) {
    console.log("  missing: ANYROUTER_STATUS_DEBUG_HOOK was not enabled, so hook stdin evidence is unavailable");
    console.log("");
    return;
  }

  for (const record of records) {
    console.log(`  ${record.at} ${record.eventName} ${record.stage}`);
    if (record.stage === "received") {
      const input = record.data?.input || {};
      console.log(`    input direct model: ${input.directInputModelClass || "unknown"}`);
      console.log(`    input error: ${input.errorType || "unknown"} status=${input.errorStatusCode ?? "null"}`);
      printCandidates("input model candidates", input.modelCandidates || []);
      continue;
    }

    if (record.stage === "prompt_start") {
      console.log(`    prompt model: ${record.data?.promptModelClass || "unknown"} source=${record.data?.promptSource || "unknown"}`);
      console.log(`    session before: ${formatTurn(record.data?.sessionBefore)}`);
      for (const output of record.data?.promptTranscript?.modelSetOutputs || []) {
        console.log(`    model set output: parsed=${output.modelClass} ansi=${output.hasAnsi} text="${output.textPreview}"`);
      }
      continue;
    }

    if (record.stage === "completion") {
      const resolution = record.data?.modelResolution || {};
      console.log(`    final model: ${resolution.modelClass || "unknown"} source=${resolution.source || "unknown"}`);
      console.log(`    direct=${resolution.directInputModelClass || "unknown"} transcript=${resolution.transcriptModelClass || "unknown"} fallbacks=${JSON.stringify(resolution.fallbackModelClasses || [])}`);
      for (const observation of record.data?.transcript?.modelObservations || []) {
        console.log(`    transcript model observation: type=${observation.recordType || "unknown"} class=${observation.modelClass}`);
        printCandidates("candidates", observation.candidates || [], "      ");
      }
      continue;
    }

    if (record.data?.modelClass) console.log(`    model: ${record.data.modelClass}`);
  }
  console.log("");
}

function printTranscriptSummary(records) {
  console.log("transcript evidence:");
  if (records.length === 0) {
    console.log("  missing or empty");
    return;
  }

  let count = 0;
  for (const record of records) {
    const output = inspectModelSetOutput(record);
    if (output) {
      count += 1;
      console.log(`  ${record.timestamp || "(no timestamp)"} model stdout current=${output.currentParserModel} stripped=${output.ansiStrippedModel} ansi=${output.hasAnsi}`);
      console.log(`    text="${output.textPreview}"`);
    }

    const candidates = collectModelCandidates(record, "record");
    if (candidates.length > 0) {
      count += 1;
      console.log(`  ${record.timestamp || "(no timestamp)"} model fields type=${formatRecordType(record)}`);
      printCandidates("candidates", candidates, "    ");
    }
  }

  if (count === 0) console.log("  no model command output or model fields found");
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
    currentParserModel: parseModelSetOutput(content),
    ansiStrippedModel: parseModelSetOutput(stripAnsiControlSequences(content)),
    hasAnsi: hasAnsiControlSequence(content),
    textPreview: previewText(content)
  };
}

function parseModelSetOutput(text) {
  const match = text.match(/(?:^|[>\r\n])\s*set\s+model\s+to\s+(opus|sonnet|haiku)\b/i);
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
  return join(getStateRoot(), "anyrouter-status-monitor", "debug-hook.jsonl");
}

function getStateRoot() {
  return (
    process.env.ANYROUTER_STATUS_STATE_DIR ||
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

function formatRecordType(record) {
  return [record.type, record.subtype].filter(Boolean).join(":") || "unknown";
}
