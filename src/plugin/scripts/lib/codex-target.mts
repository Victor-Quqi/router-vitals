import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { matchTargetBaseUrl, TARGET_HOSTS } from "./policy.mjs";

export interface CodexConfigSnapshot {
  providerBaseUrls: Record<string, string>;
}

export interface CodexTargetMatch {
  matched: boolean;
  host: string | null;
  providerId: string | null;
  baseUrl: string | null;
}

export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
  return join(homedir(), ".codex");
}

export async function readCodexConfigSnapshot(env: NodeJS.ProcessEnv = process.env): Promise<CodexConfigSnapshot | null> {
  try {
    const raw = await readFile(join(getCodexHome(env), "config.toml"), "utf8");
    return parseCodexConfigSnapshot(raw);
  } catch {
    return null;
  }
}

// Minimal TOML subset reader: section headers plus string-valued provider
// base_url keys. Anything unparsable is ignored so resolution stays
// conservative; secrets like env_key values are never read.
export function parseCodexConfigSnapshot(tomlText: string): CodexConfigSnapshot {
  const snapshot: CodexConfigSnapshot = {
    providerBaseUrls: {}
  };

  let sectionPath: string[] = [];
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
    if (sectionMatch) {
      sectionPath = parseSectionPath(sectionMatch[1] ?? "");
      continue;
    }

    const keyValue = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!keyValue) continue;
    const key = keyValue[1] ?? "";
    const value = parseTomlStringValue(keyValue[2] ?? "");
    if (value === null) continue;

    if (sectionPath.length === 2 && sectionPath[0] === "model_providers" && key === "base_url") {
      snapshot.providerBaseUrls[sectionPath[1] ?? ""] = value;
    }
  }

  return snapshot;
}

export function resolveCodexTarget({
  sessionProviderId,
  config,
  targetHosts = TARGET_HOSTS
}: {
  sessionProviderId: string | null;
  config: CodexConfigSnapshot | null;
  targetHosts?: readonly string[];
}): CodexTargetMatch {
  const providerId = sessionProviderId;
  if (!providerId) return { matched: false, host: null, providerId: null, baseUrl: null };

  const baseUrl = config?.providerBaseUrls[providerId] ?? null;
  if (!baseUrl) return { matched: false, host: null, providerId, baseUrl: null };
  const match = matchTargetBaseUrl(baseUrl, targetHosts);
  return { matched: match.matched, host: match.host, providerId, baseUrl };
}

function parseSectionPath(rawSection: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of rawSection.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current.trim());
  return segments.filter((segment) => segment !== "");
}

function parseTomlStringValue(rawValue: string): string | null {
  const value = rawValue.trim();
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return null;

  let result = "";
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote === '"' && char === "\\") {
      const next = value[index + 1];
      if (next === '"' || next === "\\") {
        result += next;
        index += 1;
        continue;
      }
    }
    if (char === quote) return result;
    result += char;
  }
  return null;
}
