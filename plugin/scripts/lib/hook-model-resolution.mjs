import { MODEL_CLASSES, classifyModel } from "./policy.mjs";
import { inspectPromptStartTranscript } from "./hook-transcript.mjs";
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
        const sessionModelClass = session?.modelClass;
        const firstPromptSessionModelClass = session?.promptCount === 0 && sessionModelClass && sessionModelClass !== "unknown"
            ? sessionModelClass
            : "unknown";
        if (firstPromptSessionModelClass !== "unknown") {
            return {
                modelClass: firstPromptSessionModelClass,
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
