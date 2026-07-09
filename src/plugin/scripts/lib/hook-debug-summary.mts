import {
  classifyError,
  classifyModel,
  createErrorHint,
  extractErrorStatusCode,
  type ReportPayload
} from "./policy.mjs";
import type { PendingTurn, SessionState } from "./state.mjs";
import {
  collectModelCandidates,
  getTranscriptPath,
  type HookInput
} from "./hook-transcript.mjs";

export function summarizeHookInput(input: HookInput): Record<string, unknown> {
  return {
    keys: Object.keys(input).sort(),
    directInputModelClass: classifyModel(input, { includeEnv: false }),
    envModelClass: classifyModel({}, { includeEnv: true }),
    modelCandidates: collectModelCandidates(input, "input"),
    transcriptPath: getTranscriptPath(input),
    errorType: classifyError(input),
    errorStatusCode: extractErrorStatusCode(input),
    errorHint: createErrorHint(input)
  };
}

export function summarizeTurnState(turn: PendingTurn | SessionState | undefined): Record<string, unknown> | null {
  if (!turn) return null;
  return {
    ...("startedAtMs" in turn ? { startedAtMs: turn.startedAtMs } : {}),
    ...("updatedAtMs" in turn ? { updatedAtMs: turn.updatedAtMs } : {}),
    ...("transcriptStartOffset" in turn && typeof turn.transcriptStartOffset === "number"
      ? { transcriptStartOffset: turn.transcriptStartOffset }
      : {}),
    ...("client" in turn ? { client: turn.client, settlementId: turn.settlementId } : {}),
    ...("transcriptPath" in turn && turn.transcriptPath ? { transcriptPath: turn.transcriptPath } : {}),
    ...(turn.transcriptKey ? { transcriptKey: turn.transcriptKey } : {}),
    ...("targetMatched" in turn ? { targetMatched: turn.targetMatched } : {}),
    ...("turnId" in turn && turn.turnId ? { turnId: turn.turnId } : {}),
    ...("promptCount" in turn ? { promptCount: turn.promptCount } : {}),
    ...(turn.modelClass ? { modelClass: turn.modelClass } : {})
  };
}

export function summarizePayload(payload: ReportPayload, validationOk: boolean): Record<string, unknown> {
  return {
    validationOk,
    ok: payload.ok,
    errorType: payload.errorType,
    errorStatusCode: payload.errorStatusCode,
    errorHint: payload.errorHint,
    modelClass: payload.modelClass,
    assistantStartBucket: payload.assistantStartBucket,
    targetMatched: payload.targetMatched,
    targetHost: payload.targetHost,
    sampleRate: payload.sampleRate,
    pluginVersion: payload.pluginVersion
  };
}
