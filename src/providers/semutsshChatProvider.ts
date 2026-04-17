import * as vscode from "vscode";
import type {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatProvider,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import { tryParseJSONObject } from "../utils";
import { Logger } from "../utils/logger";
import { SemutsshProviderBase } from "./semutsshProviderBase";
import { countTokens } from "../adapters/tokenUtils";
import { decodeSSE } from "../adapters/sse/sseDecoder";
import { createInitialStreamingState, interpretStreamEvent } from "../adapters/streaming/liteLLMStreamInterpreter";
import type { StreamingState } from "../adapters/streaming/liteLLMStreamInterpreter";
import { emitPartsToVSCode } from "../adapters/streaming/vscodePartEmitter";

export class SemutsshChatProvider extends SemutsshProviderBase implements LanguageModelChatProvider {
    private _streamingState: StreamingState = createInitialStreamingState();
    private _partialAssistantText = "";

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        return this.discoverModels(options, token);
    }

    async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        token: CancellationToken
    ): Promise<number> {
        return super.provideTokenCount(model, text, token);
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatRequestMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        this.resetStreamingState();
        const requestId = Math.random().toString(36).substring(7);

        const telemetry = this.getTelemetryOptions(options);
        const modelWithTags = model as vscode.LanguageModelChatInformation & { tags?: string[] };
        const caller = telemetry.caller || modelWithTags.tags?.[0] || "chat";

        Logger.info(
            `Chat request started | RequestID: ${requestId} | Model: ${model.id} | Caller: ${caller}`
        );

        const trackingProgress: Progress<LanguageModelResponsePart> = {
            report: (part) => {
                if (part instanceof vscode.LanguageModelTextPart) {
                    this._partialAssistantText += part.value;
                }
                progress.report(part);
            },
        };

        try {
            const config = await this._configManager.getConfig();

            if (!config.url) {
                throw new Error("Semutssh configuration not found. Please configure the Semutssh base URL.");
            }

            const modelInfo = this._modelInfoCache.get(model.id);
            const requestBody = await this.buildOpenAIChatRequest(messages, model, options, modelInfo, caller);

            const tokensIn = countTokens(messages, model.id, modelInfo);

            let stream: ReadableStream<Uint8Array>;
            try {
                stream = await this.sendRequestToSemutssh(requestBody, token, modelInfo);
            } catch (err: unknown) {
                if (token.isCancellationRequested) {
                    throw new Error("Operation cancelled by user", { cause: err });
                }

                if (err instanceof Error && err.message.includes("Semutssh API error")) {
                    const errorText = err.message.split("\n").slice(1).join("\n");
                    const parsedMessage = this.parseApiError(400, errorText);
                    if (
                        parsedMessage.toLowerCase().includes("unsupported parameter") ||
                        parsedMessage.toLowerCase().includes("not supported")
                    ) {
                        Logger.warn(`Retrying request without optional parameters due to: ${parsedMessage}`);
                        delete requestBody.temperature;
                        delete requestBody.top_p;
                        delete requestBody.frequency_penalty;
                        delete requestBody.presence_penalty;
                        delete requestBody.stop;

                        if (token.isCancellationRequested) {
                            throw new Error("Operation cancelled by user", { cause: err });
                        }
                        try {
                            stream = await this.sendRequestToSemutssh(requestBody, token, modelInfo);
                            await this.processStreamingResponse(stream, trackingProgress, token);
                            return;
                        } catch (retryErr: unknown) {
                            let retryErrorMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
                            if (retryErrorMessage.includes("Semutssh API error")) {
                                const statusMatch = retryErrorMessage.match(/error: (\d+)/);
                                const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 400;
                                const errorParts = retryErrorMessage.split("\n");
                                const errorText = errorParts.length > 1 ? errorParts.slice(1).join("\n") : "";
                                const parsedMsg = this.parseApiError(statusCode, errorText);
                                retryErrorMessage = `Semutssh Error (${model.id}): ${parsedMsg}. This model may not support certain parameters.`;
                            }
                            throw new Error(retryErrorMessage, { cause: retryErr });
                        }
                    } else {
                        throw err;
                    }
                } else {
                    throw err;
                }
            }

            await this.processStreamingResponse(stream, trackingProgress, token);
            Logger.info(`Chat request completed | RequestID: ${requestId} | TokensIn: ${tokensIn}`);
        } catch (err: unknown) {
            let errorMessage = err instanceof Error ? err.message : String(err);
            if (errorMessage.includes("Semutssh API error")) {
                const statusMatch = errorMessage.match(/error: (\d+)/);
                const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 400;
                const errorParts = errorMessage.split("\n");
                const errorText = errorParts.length > 1 ? errorParts.slice(1).join("\n") : "";
                const parsedMessage = this.parseApiError(statusCode, errorText);
                errorMessage = `Semutssh Error (${model.id}): ${parsedMessage}`;
            }
            Logger.error("Chat request failed", err);
            throw new Error(errorMessage, { cause: err });
        }
    }

    protected resetStreamingState(): void {
        this._streamingState = createInitialStreamingState();
        this._partialAssistantText = "";
    }

    protected async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const TIMEOUT_MS = 60000; // 60 second inactivity timeout
        let watchdog: NodeJS.Timeout | undefined;

        const resetWatchdog = () => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            watchdog = setTimeout(() => {
                Logger.warn(`Inactivity timeout after ${TIMEOUT_MS}ms`);
            }, TIMEOUT_MS);
        };

        token.onCancellationRequested(() => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
        });

        try {
            resetWatchdog();
            for await (const payload of decodeSSE(responseBody, token)) {
                resetWatchdog();
                if (token.isCancellationRequested) {
                    break;
                }

                const jsonResult = tryParseJSONObject(payload);
                if (!jsonResult.ok) {
                    continue;
                }
                const json = jsonResult.value;

                if (!this._streamingState) {
                    this.resetStreamingState();
                }

                const parts = interpretStreamEvent(json, this._streamingState);
                emitPartsToVSCode(parts, progress);
            }
        } finally {
            if (watchdog) {
                clearTimeout(watchdog);
            }
        }
    }
}
