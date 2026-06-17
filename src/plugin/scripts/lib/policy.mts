import { createHash, randomBytes } from "node:crypto";

export * from "./policy-core.mjs";

export function createAnonymousId(): string {
  return `anon_${randomBytes(18).toString("base64url")}`;
}

export function hashLocalSessionId(sessionId: unknown): string {
  if (typeof sessionId !== "string" || sessionId.length === 0) return "default";
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}
