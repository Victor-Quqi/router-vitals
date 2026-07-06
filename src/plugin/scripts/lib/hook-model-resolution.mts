import {
  MODEL_CLASSES,
  classifyModel,
  type ModelClass
} from "./policy.mjs";
import type { TurnState } from "./state.mjs";
import {
  inspectRecentProjectModelSwitch,
  inspectPromptStartTranscript,
  type HookInput,
  type ProjectModelSwitchInspection,
  type PromptTranscriptInspection,
  type TranscriptInspection
} from "./hook-transcript.mjs";

export type ModelResolutionSource = "direct_input" | "turn_transcript" | "fallback" | "unknown";
export type PromptModelSource = "direct_input" | "prompt_transcript" | "project_model_switch" | "unparsed_model_set_output" | "session" | "unknown";

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
  projectModelSwitch: ProjectModelSwitchInspection;
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
  const emptyProjectModelSwitch: ProjectModelSwitchInspection = {
    inspected: false,
    modelClass: "unknown",
    timestampMs: null,
    transcriptPath: null,
    textPreview: null
  };
  if (direct !== "unknown") {
    return {
      modelClass: direct,
      source: "direct_input",
      directInputModelClass: direct,
      transcript: emptyTranscript,
      projectModelSwitch: emptyProjectModelSwitch
    };
  }

  const transcript = await inspectPromptStartTranscript(input, transcriptStartOffset);
  const projectModelSwitch = transcript.modelClass === "unknown" && !transcript.hasUnparsedModelSetOutput
    ? await inspectRecentProjectModelSwitch(input)
    : emptyProjectModelSwitch;

  if (!transcript.inspected) {
    if (projectModelSwitch.modelClass !== "unknown") {
      return {
        modelClass: projectModelSwitch.modelClass,
        source: "project_model_switch",
        directInputModelClass: direct,
        transcript,
        projectModelSwitch
      };
    }

    const sessionModelClass = session?.modelClass;
    const firstPromptSessionModelClass = session?.promptCount === 0 && sessionModelClass && sessionModelClass !== "unknown"
      ? sessionModelClass
      : "unknown";
    if (firstPromptSessionModelClass !== "unknown") {
      return {
        modelClass: firstPromptSessionModelClass,
        source: "session",
        directInputModelClass: direct,
        transcript,
        projectModelSwitch
      };
    }

    return {
      modelClass: "unknown",
      source: "unknown",
      directInputModelClass: direct,
      transcript,
      projectModelSwitch
    };
  }

  if (transcript.modelClass !== "unknown") {
    return {
      modelClass: transcript.modelClass,
      source: "prompt_transcript",
      directInputModelClass: direct,
      transcript,
      projectModelSwitch
    };
  }

  if (transcript.hasUnparsedModelSetOutput) {
    return {
      modelClass: "unknown",
      source: "unparsed_model_set_output",
      directInputModelClass: direct,
      transcript,
      projectModelSwitch
    };
  }

  if (projectModelSwitch.modelClass !== "unknown") {
    return {
      modelClass: projectModelSwitch.modelClass,
      source: "project_model_switch",
      directInputModelClass: direct,
      transcript,
      projectModelSwitch
    };
  }

  const sessionModelClass = session?.modelClass && session.modelClass !== "unknown" ? session.modelClass : "unknown";
  if (sessionModelClass !== "unknown") {
    return {
      modelClass: sessionModelClass,
      source: "session",
      directInputModelClass: direct,
      transcript,
      projectModelSwitch
    };
  }

  return {
    modelClass: "unknown",
    source: "unknown",
    directInputModelClass: direct,
    transcript,
    projectModelSwitch
  };
}
