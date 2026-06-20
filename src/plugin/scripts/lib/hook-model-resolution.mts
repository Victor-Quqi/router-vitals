import {
  MODEL_CLASSES,
  classifyModel,
  type ModelClass
} from "./policy.mjs";
import type { TurnState } from "./state.mjs";
import {
  inspectPromptStartTranscript,
  type HookInput,
  type PromptTranscriptInspection,
  type TranscriptInspection
} from "./hook-transcript.mjs";

export type ModelResolutionSource = "direct_input" | "turn_transcript" | "fallback" | "unknown";
export type PromptModelSource = "direct_input" | "prompt_transcript" | "unparsed_model_set_output" | "session" | "unknown";

export interface ModelResolution {
  modelClass: ModelClass;
  source: ModelResolutionSource;
  directInputModelClass: ModelClass;
  transcriptModelClass: ModelClass;
  fallbackModelClasses: ModelClass[];
}

export interface PromptModelResolution {
  modelClass: ModelClass;
  source: PromptModelSource;
  directInputModelClass: ModelClass;
  transcript: PromptTranscriptInspection;
}

export function resolveModelClass(
  input: HookInput,
  transcript: TranscriptInspection,
  ...fallbacks: Array<TurnState | undefined>
): ModelResolution {
  const direct = classifyModel(input, { includeEnv: false });
  const fallbackModelClasses = fallbacks
    .map((fallback) => fallback?.modelClass || "unknown")
    .filter((modelClass): modelClass is ModelClass => MODEL_CLASSES.includes(modelClass as ModelClass));
  if (direct !== "unknown") {
    return {
      modelClass: direct,
      source: "direct_input",
      directInputModelClass: direct,
      transcriptModelClass: transcript.modelClass,
      fallbackModelClasses
    };
  }

  if (transcript.modelClass !== "unknown") {
    return {
      modelClass: transcript.modelClass,
      source: "turn_transcript",
      directInputModelClass: direct,
      transcriptModelClass: transcript.modelClass,
      fallbackModelClasses
    };
  }

  for (const fallback of fallbacks) {
    if (fallback?.modelClass && fallback.modelClass !== "unknown") {
      return {
        modelClass: fallback.modelClass,
        source: "fallback",
        directInputModelClass: direct,
        transcriptModelClass: transcript.modelClass,
        fallbackModelClasses
      };
    }
  }

  return {
    modelClass: "unknown",
    source: "unknown",
    directInputModelClass: direct,
    transcriptModelClass: transcript.modelClass,
    fallbackModelClasses
  };
}

export async function resolvePromptStartModelClass(
  input: HookInput,
  session: TurnState | undefined,
  transcriptStartOffset: number | null
): Promise<PromptModelResolution> {
  const direct = classifyModel(input, { includeEnv: false });
  const emptyTranscript: PromptTranscriptInspection = {
    inspected: false,
    modelClass: "unknown",
    modelSetOutputs: [],
    hasUnparsedModelSetOutput: false
  };
  if (direct !== "unknown") {
    return {
      modelClass: direct,
      source: "direct_input",
      directInputModelClass: direct,
      transcript: emptyTranscript
    };
  }

  const transcript = await inspectPromptStartTranscript(input, transcriptStartOffset);
  if (!transcript.inspected) {
    return {
      modelClass: "unknown",
      source: "unknown",
      directInputModelClass: direct,
      transcript
    };
  }

  if (transcript.modelClass !== "unknown") {
    return {
      modelClass: transcript.modelClass,
      source: "prompt_transcript",
      directInputModelClass: direct,
      transcript
    };
  }

  if (transcript.hasUnparsedModelSetOutput) {
    return {
      modelClass: "unknown",
      source: "unparsed_model_set_output",
      directInputModelClass: direct,
      transcript
    };
  }

  const sessionModelClass = session?.modelClass && session.modelClass !== "unknown" ? session.modelClass : "unknown";
  if (sessionModelClass !== "unknown") {
    return {
      modelClass: sessionModelClass,
      source: "session",
      directInputModelClass: direct,
      transcript
    };
  }

  return {
    modelClass: "unknown",
    source: "unknown",
    directInputModelClass: direct,
    transcript
  };
}
