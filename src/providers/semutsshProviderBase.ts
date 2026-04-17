import * as vscode from "vscode";
import type {
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type {
    LiteLLMModelInfo,
    OpenAIChatCompletionRequest,
    OpenAIFunctionToolDef,
} from "../types";
import { convertMessages, convertTools, validateRequest } from "../utils";
import { countTokens, trimMessagesToFitBudget } from "../adapters/tokenUtils";
import { ConfigManager } from "../config/configManager";
import { Logger } from "../utils/logger";
import {
    deriveCapabilitiesFromModelInfo,
    capabilitiesToVSCode,
    getModelTags as getDerivedModelTags,
} from "../utils/modelCapabilities";
import type { DerivedModelCapabilities } from "../utils/modelCapabilities";
import { SemutsshClient } from "../adapters/semutsshClient";

const KNOWN_PARAMETER_LIMITATIONS: Record<string, Set<string>> = {
    "claude-3-5-sonnet": new Set(["temperature"]),
    "claude-3-5-haiku": new Set(["temperature"]),
    "claude-3-opus": new Set(["temperature"]),
    "claude-3-sonnet": new Set(["temperature"]),
    "claude-3-haiku": new Set(["temperature"]),
    "claude-haiku-4-5": new Set(["temperature"]),
    "gpt-5.1-codex": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "gpt-5.1-codex-mini": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "gpt-5.1-codex-max": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "codex-mini-latest": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "o1-": new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty"]),
    "gpt-5": new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty"]),
};

export abstract class SemutsshProviderBase {
    protected readonly _configManager: ConfigManager;
    protected readonly _onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformationEmitter.event;

    protected readonly _modelInfoCache = new Map<string, LiteLLMModelInfo | undefined>();
    protected readonly _derivedCapabilitiesCache = new Map<string, DerivedModelCapabilities>();
    protected readonly _parameterProbeCache = new Map<string, Set<string>>();
    protected _lastModelList: LanguageModelChatInformation[] = [];
    protected _modelListFetchedAtMs = 0;
    private _inFlightDiscovery: Promise<vscode.LanguageModelChatInformation[]> | undefined;

    constructor(
        protected readonly secrets: vscode.SecretStorage,
        protected readonly userAgent: string
    ) {
        this._configManager = new ConfigManager(secrets);
    }

    public getConfigManager(): ConfigManager {
        return this._configManager;
    }

    public refreshModelInformation(): void {
        Logger.info("Firing onDidChangeLanguageModelChatInformation");
        this._onDidChangeLanguageModelChatInformationEmitter.fire();
    }

    public clearModelCache(): void {
        Logger.info("Clearing model discovery cache");
        this._modelInfoCache.clear();
        this._derivedCapabilitiesCache.clear();
        this._parameterProbeCache.clear();
        this._lastModelList = [];
        this._modelListFetchedAtMs = 0;
        this.refreshModelInformation();
        Logger.info("Cleared cache");
    }

    public getLastKnownModels(): LanguageModelChatInformation[] {
        return this._lastModelList;
    }

    public getModelInfo(modelId: string): LiteLLMModelInfo | undefined {
        return this._modelInfoCache.get(modelId);
    }

    public async discoverModels(
        options: { silent: boolean },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        if (this._inFlightDiscovery) {
            Logger.trace("Returning in-flight discovery promise");
            return this._inFlightDiscovery;
        }

        const TTL_MS = 30000;
        const now = Date.now();
        if (options.silent && this._lastModelList.length > 0 && now - this._modelListFetchedAtMs < TTL_MS) {
            Logger.trace("Returning cached models (within TTL)");
            return this._lastModelList;
        }

        this._inFlightDiscovery = (async () => {
            try {
                return await this._doDiscoverModels(options, token);
            } finally {
                this._inFlightDiscovery = undefined;
            }
        })();

        return this._inFlightDiscovery;
    }

    private async _doDiscoverModels(
        options: { silent: boolean },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        Logger.trace("discoverModels called");
        try {
            const config = await this._configManager.getConfig();
            Logger.debug(`Config URL: ${config.url ? "set" : "not set"}`);
            if (!config.url) {
                if (!options.silent) {
                    Logger.info("No base URL configured; prompting for configuration (silent=false)");
                    await vscode.commands.executeCommand("semutssh.configure");

                    const refreshed = await this._configManager.getConfig();
                    if (!refreshed.url) {
                        Logger.info("Configuration was not completed; returning empty model list.");
                        return [];
                    }
                    Logger.debug("Configuration completed; continuing model discovery.");
                } else {
                    Logger.info("No base URL configured, returning empty model list.");
                    return [];
                }
            }

            const effectiveConfig = await this._configManager.getConfig();
            if (!effectiveConfig.url) {
                Logger.info("No base URL configured after prompt, returning empty model list.");
                return [];
            }

            const client = new SemutsshClient(effectiveConfig, this.userAgent);
            Logger.trace("Fetching model info from Semutssh...");

            let data: Array<{ model_info?: LiteLLMModelInfo; model_name?: string }> = [];
            try {
                const result = await client.getModelInfo(token);
                data = result.data ?? [];
            } catch (err) {
                // If /model/info is blocked (403), fall back to custom models only.
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes("403")) {
                    Logger.warn("Key cannot access /model/info — using custom models only");
                } else {
                    Logger.error("Failed to fetch model info", err);
                }
                data = [];
            }

            if (!Array.isArray(data)) {
                Logger.warn("Received invalid data format from /model/info", data);
                data = [];
            }

            Logger.info(`Found ${data.length} models`);

            const infos: LanguageModelChatInformation[] = data.map(
                (entry: { model_info?: LiteLLMModelInfo; model_name?: string }, index: number) => {
                    const modelId = entry.model_info?.key ?? entry.model_name ?? `model-${index}`;
                    const modelInfo = entry.model_info;
                    this._modelInfoCache.set(modelId, modelInfo);

                    const derived = deriveCapabilitiesFromModelInfo(modelId, modelInfo);
                    this._derivedCapabilitiesCache.set(modelId, derived);

                    const capabilities = capabilitiesToVSCode(derived);
                    const tags = getDerivedModelTags(modelId, derived, undefined);

                    const formatTokens = (num: number): string => {
                        if (num >= 1000000) {
                            return `${(num / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
                        }
                        if (num >= 1000) {
                            return `${Math.floor(num / 1000)}K`;
                        }
                        return num.toString();
                    };

                    const inputDesc = formatTokens(derived.rawContextWindow);
                    const outputDesc = formatTokens(derived.maxOutputTokens);
                    const tooltip = `${modelInfo?.litellm_provider ?? "semutssh"} (${modelInfo?.mode ?? "chat"}) — Context: ${inputDesc} in / ${outputDesc} out`;

                    const provider = modelInfo?.litellm_provider?.toLowerCase();
                    let family = "litellm";
                    if (provider === "openai") {
                        family = "gpt4";
                    } else if (provider === "anthropic") {
                        family = "claude";
                    }

                    const info = {
                        id: modelId,
                        name: entry.model_name ?? modelId,
                        tooltip,
                        detail: `Context: ${inputDesc} | Output: ${outputDesc}`,
                        family,
                        version: "1.0.0",
                        maxInputTokens: derived.rawContextWindow,
                        maxOutputTokens: derived.maxOutputTokens,
                        capabilities,
                        tags,
                    };

                    return info as vscode.LanguageModelChatInformation;
                }
            );

            // Apply custom models
            const customInfos: LanguageModelChatInformation[] = effectiveConfig.customModels.map((model) => {
                const derived: DerivedModelCapabilities = {
                    supportsTools: true,
                    supportsVision: false,
                    supportsStreaming: true,
                    endpointMode: "chat",
                    maxInputTokens: model.contextWindow,
                    maxOutputTokens: model.maxOutputTokens,
                    rawContextWindow: model.contextWindow,
                };

                return {
                    id: model.id,
                    name: model.name,
                    tooltip: `${model.provider} (custom) — Context: ${model.contextWindow} in / ${model.maxOutputTokens} out`,
                    detail: `Context: ${model.contextWindow} | Output: ${model.maxOutputTokens}`,
                    family: model.provider.toLowerCase().includes("anthropic")
                        ? "claude"
                        : model.provider.toLowerCase().includes("openai")
                          ? "gpt4"
                          : "litellm",
                    version: "1.0.0",
                    maxInputTokens: derived.maxInputTokens,
                    maxOutputTokens: derived.maxOutputTokens,
                    capabilities: capabilitiesToVSCode(derived),
                    tags: [],
                } as vscode.LanguageModelChatInformation;
            });

            let allModels = [...infos, ...customInfos];

            // Apply hidden filter
            if (effectiveConfig.hiddenModels.length > 0) {
                const hiddenSet = new Set(effectiveConfig.hiddenModels);
                allModels = allModels.filter((m) => !hiddenSet.has(m.id));
            }

            const hasChanged = JSON.stringify(this._lastModelList) !== JSON.stringify(allModels);
            this._lastModelList = allModels;
            this._modelListFetchedAtMs = Date.now();

            if (hasChanged) {
                this.refreshModelInformation();
            }

            return allModels;
        } catch (err) {
            Logger.error("Failed to fetch models", err);
            return [];
        }
    }

    async provideTokenCount(
        model: vscode.LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        const modelInfo = this._modelInfoCache.get(model.id);
        const localCount = countTokens(text, model.id, modelInfo);

        if (typeof text === "string" && text.length < 200) {
            return localCount;
        }

        return localCount;
    }

    protected getModelTags(
        modelId: string,
        modelInfo?: LiteLLMModelInfo,
        overrides?: Record<string, string[]>
    ): string[] {
        const tags = new Set<string>();

        const modelName = modelId.toLowerCase();
        if (modelName.includes("coder") || modelName.includes("code")) {
            tags.add("inline-edit");
        }

        if (
            modelInfo?.supports_function_calling ||
            modelInfo?.supported_openai_params?.includes("tools") ||
            modelInfo?.supported_openai_params?.includes("tool_choice")
        ) {
            tags.add("tools");
        }

        if (modelInfo?.mode === "chat") {
            const supportsStreaming =
                modelInfo.supports_native_streaming === true || modelInfo.supported_openai_params?.includes("stream");

            if (supportsStreaming) {
                tags.add("inline-completions");
                tags.add("terminal-chat");
            }
        }

        if (overrides && overrides[modelId]) {
            for (const tag of overrides[modelId]) {
                tags.add(tag);
            }
        }

        return Array.from(tags);
    }

    protected getTelemetryOptions(options: vscode.ProvideLanguageModelChatResponseOptions): {
        caller?: string;
        justification?: string;
    } {
        const opt = options as vscode.ProvideLanguageModelChatResponseOptions & {
            caller?: string;
            justification?: string;
        };
        return {
            caller: opt.caller,
            justification: opt.justification,
        };
    }

    protected async buildOpenAIChatRequest(
        messages: readonly LanguageModelChatRequestMessage[],
        model: LanguageModelChatInformation,
        options: ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        caller?: string
    ): Promise<OpenAIChatCompletionRequest> {
        const telemetry = this.getTelemetryOptions(options);
        const justification = telemetry.justification;
        const effectiveCaller = caller || telemetry.caller;
        Logger.info(
            `Building request for model: ${model.id} | Caller: ${effectiveCaller || "unknown"} | Justification: ${
                justification || "none"
            }`
        );

        const toolConfig = convertTools({ ...options, tools: options.tools ?? [] });
        const messagesToUse = trimMessagesToFitBudget(messages, toolConfig.tools, model, modelInfo);

        const openaiMessages = convertMessages(messagesToUse);
        validateRequest(messagesToUse);

        const requestBody: OpenAIChatCompletionRequest = {
            model: model.id,
            messages: openaiMessages,
            stream: true,
            max_tokens:
                typeof options.modelOptions?.max_tokens === "number"
                    ? Math.min(options.modelOptions.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
        };

        const mo = (options.modelOptions as Record<string, unknown>) ?? {};

        if (this.isParameterSupported("temperature", modelInfo, model.id)) {
            requestBody.temperature = mo.temperature as number | undefined;
        }
        if (this.isParameterSupported("frequency_penalty", modelInfo, model.id)) {
            requestBody.frequency_penalty = mo.frequency_penalty as number | undefined;
        }
        if (this.isParameterSupported("presence_penalty", modelInfo, model.id)) {
            requestBody.presence_penalty = mo.presence_penalty as number | undefined;
        }

        if (this.isParameterSupported("stop", modelInfo, model.id) && mo.stop) {
            requestBody.stop = mo.stop as string | string[];
        }
        if (this.isParameterSupported("top_p", modelInfo, model.id) && typeof mo.top_p === "number") {
            requestBody.top_p = mo.top_p;
        }

        if (toolConfig.tools) {
            requestBody.tools = toolConfig.tools as unknown as OpenAIFunctionToolDef[];
        }
        if (toolConfig.tool_choice) {
            requestBody.tool_choice = toolConfig.tool_choice;
        }

        this.stripUnsupportedParametersFromRequest(requestBody as unknown as Record<string, unknown>, modelInfo, model.id);
        return requestBody;
    }

    protected async sendRequestToSemutssh(
        request: OpenAIChatCompletionRequest,
        token: vscode.CancellationToken,
        modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        const config = await this._configManager.getConfig();
        if (!config.url) {
            throw new Error("Semutssh configuration not found. Please configure the Semutssh base URL.");
        }
        const client = new SemutsshClient(config, this.userAgent);
        return client.chat(request, modelInfo?.mode, token, modelInfo);
    }

    protected isParameterSupported(param: string, modelInfo: LiteLLMModelInfo | undefined, modelId?: string): boolean {
        if (modelId) {
            if (KNOWN_PARAMETER_LIMITATIONS[modelId]?.has(param)) {
                return false;
            }
            for (const [knownModel, limitations] of Object.entries(KNOWN_PARAMETER_LIMITATIONS)) {
                if (modelId.includes(knownModel) && limitations.has(param)) {
                    return false;
                }
            }
        }

        if (!modelInfo) {
            return true;
        }

        if (modelId && this._parameterProbeCache.has(modelId)) {
            if (this._parameterProbeCache.get(modelId)?.has(param)) {
                return false;
            }
        }

        if (modelInfo.supported_openai_params) {
            return modelInfo.supported_openai_params.includes(param);
        }

        return true;
    }

    protected stripUnsupportedParametersFromRequest(
        requestBody: Record<string, unknown>,
        modelInfo: LiteLLMModelInfo | undefined,
        modelId?: string
    ): void {
        const paramsToCheck = [
            "temperature",
            "stop",
            "frequency_penalty",
            "presence_penalty",
            "top_p",
            "cache",
            "no_cache",
            "no-cache",
            "extra_body",
        ];
        for (const p of paramsToCheck) {
            if (!this.isParameterSupported(p, modelInfo, modelId) && p in requestBody) {
                delete requestBody[p];
            }
        }

        if ("cache" in requestBody) {
            delete requestBody.cache;
        }

        if (requestBody.extra_body && typeof requestBody.extra_body === "object") {
            const eb = requestBody.extra_body as Record<string, unknown>;
            if (eb.cache && typeof eb.cache === "object") {
                const cache = eb.cache as Record<string, unknown>;
                delete cache["no-cache"];
                delete cache.no_cache;
                if (Object.keys(cache).length === 0) {
                    delete eb.cache;
                }
            }
            if (Object.keys(eb).length === 0) {
                delete requestBody.extra_body;
            }
        }
    }

    protected detectQuotaToolRedaction(
        messages: readonly LanguageModelChatRequestMessage[],
        tools: readonly vscode.LanguageModelChatTool[],
        requestId: string,
        modelId: string,
        disableRedaction: boolean,
        _caller?: string
    ): { tools: readonly vscode.LanguageModelChatTool[] } {
        if (disableRedaction || !tools.length || !messages.length) {
            return { tools };
        }

        const quotaMatch = this.findQuotaErrorInMessages(messages);
        if (!quotaMatch) {
            return { tools };
        }

        const { toolName, errorText, turnIndex } = quotaMatch;
        const toolNames = new Set(tools.map((tool) => tool.name));
        if (!toolNames.has(toolName)) {
            Logger.debug("Quota error detected, but tool not present", { toolName, requestId, modelId, turnIndex });
            return { tools };
        }

        const filteredTools = tools.filter((tool) => tool.name !== toolName);
        Logger.warn("Quota error detected; redacting tool for current turn", {
            toolName,
            errorText,
            modelId,
            requestId,
            turnIndex,
        });

        return { tools: filteredTools };
    }

    private findQuotaErrorInMessages(
        messages: readonly LanguageModelChatRequestMessage[]
    ): { toolName: string; errorText: string; turnIndex: number } | undefined {
        const quotaRegex =
            /(\b429\b|rate\s*limit\s*exceeded|rate\s*limited|too\s*many\s*requests|insufficient\s*quota|quota\s*exceeded|exceeded\s*your\s*current\s*quota)/i;
        const toolRegex = /(insert_edit_into_file|replace_string_in_file)/i;

        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            const text = this.collectMessageText(message);
            if (!text) {
                continue;
            }
            if (!quotaRegex.test(text)) {
                continue;
            }
            const toolMatch = text.match(toolRegex);
            if (!toolMatch) {
                continue;
            }

            return {
                toolName: toolMatch[1],
                errorText: this.sanitizeErrorTextForLogs(text),
                turnIndex: i,
            };
        }

        return undefined;
    }

    private sanitizeErrorTextForLogs(text: string): string {
        const trimmed = (text || "").trim();
        if (!trimmed) {
            return "";
        }

        const withoutCopilotContext = trimmed
            .replace(/<context>[\s\S]*?<\/context>/gi, "<context>…</context>")
            .replace(/<editorContext>[\s\S]*?<\/editorContext>/gi, "<editorContext>…</editorContext>")
            .replace(
                /<reminderInstructions>[\s\S]*?<\/reminderInstructions>/gi,
                "<reminderInstructions>…</reminderInstructions>"
            );

        return withoutCopilotContext.length > 500 ? `${withoutCopilotContext.slice(0, 500)}…` : withoutCopilotContext;
    }

    private collectMessageText(message: LanguageModelChatRequestMessage): string {
        const parts = message.content ?? [];
        let text = "";
        for (const part of parts) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            } else if (typeof part === "string") {
                text += part;
            }
        }
        return text.trim();
    }

    protected buildCapabilities(modelInfo: LiteLLMModelInfo | undefined): vscode.LanguageModelChatCapabilities {
        if (!modelInfo) {
            return {
                toolCalling: true,
                imageInput: false,
            };
        }

        return {
            toolCalling: modelInfo.supports_function_calling !== false,
            imageInput: modelInfo.supports_vision === true,
        };
    }

    protected parseApiError(statusCode: number, errorText: string): string {
        try {
            const parsed = JSON.parse(errorText);
            if (parsed.error?.message) {
                return parsed.error.message;
            }
        } catch {
            // ignore
        }
        if (errorText) {
            return errorText.slice(0, 200);
        }
        return `API request failed with status ${statusCode}`;
    }
}
