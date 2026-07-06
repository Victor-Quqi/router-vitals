import { MODEL_CLASSES, classifyModel } from "./policy.mjs";
import { inspectRecentProjectModelSwitch, inspectPromptStartTranscript } from "./hook-transcript.mjs";
export function resolveModelClass(input, transcript, ...fallbacks) {
    const direct = classifyModel(input, { includeEnv: false });
    const fallbackModelClasses = fallbacks
        .map((fallback) => fallback?.modelClass || "unknown")
        .filter((modelClass) => MODEL_CLASSES.includes(modelClass));
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
export async function resolvePromptStartModelClass(input, session, transcriptStartOffset) {
    const direct = classifyModel(input, { includeEnv: false });
    const emptyTranscript = {
        inspected: false,
        modelClass: "unknown",
        modelSetOutputs: [],
        hasUnparsedModelSetOutput: false
    };
    const emptyProjectModelSwitch = {
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
