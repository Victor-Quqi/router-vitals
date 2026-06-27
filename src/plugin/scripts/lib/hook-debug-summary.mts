import {
  classifyError,
  classifyModel,
  createErrorHint,
  extractErrorStatusCode,
  type ReportPayload
} from "./policy.mjs";
import type { TurnState } from "./state.mjs";
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

export function summarizeTurnState(turn: TurnState | undefined): Record<string, unknown> | null {
  if (!turn) return null;
  return {
    ...(typeof turn.startedAtMs === "number" ? { startedAtMs: turn.startedAtMs } : {}),
    ...(typeof turn.updatedAtMs === "number" ? { updatedAtMs: turn.updatedAtMs } : {}),
    ...(typeof turn.transcriptStartOffset === "number" ? { transcriptStartOffset: turn.transcriptStartOffset } : {}),
    ...(typeof turn.targetMatched === "boolean" ? { targetMatched: turn.targetMatched } : {}),
    ...(typeof turn.promptCount === "number" ? { promptCount: turn.promptCount } : {}),
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
