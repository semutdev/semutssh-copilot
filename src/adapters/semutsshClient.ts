import type * as vscode from "vscode";
import type {
    LiteLLMModelInfoResponse,
    OpenAIChatCompletionRequest,
    LiteLLMModelInfo,
    LiteLLMTokenCounterRequest,
    LiteLLMTokenCounterResponse,
    SemutsshConfig,
} from "../types";
import { Logger } from "../utils/logger";
import { isAnthropicModel } from "../utils/modelUtils";

export class SemutsshClient {
    constructor(
        private readonly config: SemutsshConfig,
        private readonly userAgent: string
    ) {}

    async getModelInfo(token?: vscode.CancellationToken): Promise<LiteLLMModelInfoResponse> {
        const controller = new AbortController();
        if (token) {
            token.onCancellationRequested(() => controller.abort());
        }

        Logger.trace(`Fetching model info from ${this.config.url}/model/info`);
        const resp = await fetch(`${this.config.url}/model/info`, {
            headers: this.getHeaders(),
            signal: controller.signal,
        });
        if (!resp.ok) {
            Logger.error(`Failed to fetch model info: ${resp.status} ${resp.statusText}`);
            throw new Error(`Failed to fetch model info: ${resp.status} ${resp.statusText}`);
        }
        return resp.json() as Promise<LiteLLMModelInfoResponse>;
    }

    async checkConnection(
        token?: vscode.CancellationToken
    ): Promise<{ latencyMs: number; modelCount: number; sampleModelIds: string[] }> {
        const startTime = Date.now();

        // Try /model/info first; if it fails with 403 (key doesn't have permission),
        // fall back to probing /chat/completions with a minimal request.
        let modelCount = 0;
        let sampleModelIds: string[] = [];

        try {
            const { data } = await this.getModelInfo(token);
            modelCount = Array.isArray(data) ? data.length : 0;
            sampleModelIds = Array.isArray(data)
                ? data
                      .slice(0, 5)
                      .map(
                          (entry: { model_info?: { key?: string }; model_name?: string }) =>
                              entry.model_info?.key ?? entry.model_name ?? "unknown"
                      )
                : [];
        } catch (firstErr) {
            // If /model/info returns 403, the key only has access to /chat/completions.
            // Probe with a minimal POST to confirm connectivity.
            if (firstErr instanceof Error && firstErr.message.includes("403")) {
                Logger.warn("Key cannot access /model/info — probing /chat/completions instead");
                const controller = new AbortController();
                if (token) {
                    token.onCancellationRequested(() => controller.abort());
                }
                const probeResp = await fetch(`${this.config.url}/chat/completions`, {
                    method: "POST",
                    headers: this.getHeaders(),
                    body: JSON.stringify({
                        model: "claude-opus-4-6",
                        messages: [{ role: "user", content: "hi" }],
                        stream: false,
                    }),
                    signal: controller.signal,
                });
                // Read and discard the body
                try {
                    await probeResp.text();
                } catch {
                    // ignore
                }
                modelCount = 0;
                sampleModelIds = ["(key does not support model listing)"];
            } else {
                throw firstErr;
            }
        }

        const latencyMs = Date.now() - startTime;
        return { latencyMs, modelCount, sampleModelIds };
    }

    async countTokens(
        request: LiteLLMTokenCounterRequest,
        token?: vscode.CancellationToken
    ): Promise<LiteLLMTokenCounterResponse> {
        const controller = new AbortController();
        if (token) {
            token.onCancellationRequested(() => controller.abort());
        }

        Logger.trace(`Counting tokens for model ${request.model} at ${this.config.url}/utils/token_counter`);
        const resp = await fetch(`${this.config.url}/utils/token_counter`, {
            method: "POST",
            headers: this.getHeaders(),
            body: JSON.stringify(request),
            signal: controller.signal,
        });

        if (!resp.ok) {
            const errorText = await resp.text();
            Logger.error(`Failed to count tokens: ${resp.status} ${resp.statusText} - ${errorText}`);
            throw new Error(`Failed to count tokens: ${resp.status} ${resp.statusText}`);
        }

        return resp.json() as Promise<LiteLLMTokenCounterResponse>;
    }

    async chat(
        request: OpenAIChatCompletionRequest,
        mode?: string,
        token?: vscode.CancellationToken,
        modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        let body = request;

        const isAnthropic = isAnthropicModel(request.model, modelInfo);
        if (!isAnthropic) {
            body = this.withNoCacheExtraBody(body);
        }

        const endpoint = mode === "completions" ? "/chat/completions" : "/chat/completions";

        Logger.trace(`Sending chat request to ${endpoint}`, { model: request.model });
        let response = await this.fetchWithRateLimit(
            `${this.config.url}${endpoint}`,
            {
                method: "POST",
                headers: this.getHeaders(request.model, modelInfo),
                body: JSON.stringify(body),
            },
            { token }
        );

        // Handle unsupported parameters by stripping them and retrying once
        if (response.status === 400) {
            const errorText = await response.clone().text();
            const errorLower = errorText.toLowerCase();

            if (
                errorLower.includes("unsupported parameter") ||
                errorLower.includes("unknown parameter") ||
                errorLower.includes("extra_headers") ||
                errorLower.includes("no-cache") ||
                errorLower.includes("unexpected keyword argument")
            ) {
                Logger.warn(`Detected unsupported parameters for ${request.model}, attempting to strip and retry.`);

                const strippedBody = JSON.parse(JSON.stringify(body));
                const headers = this.getHeaders(request.model, modelInfo);

                const paramMatch = errorText.match(/(?:parameter|argument|key)\s+['"]?([a-zA-Z0-9_-]+)['"]?/i);
                if (paramMatch && paramMatch[1]) {
                    delete strippedBody[paramMatch[1]];
                }

                if (errorLower.includes("unknown parameter") && errorLower.includes("cache")) {
                    delete strippedBody.cache;
                    if (strippedBody.extra_body && typeof strippedBody.extra_body === "object") {
                        const eb = strippedBody.extra_body as Record<string, unknown>;
                        if (eb.cache && typeof eb.cache === "object") {
                            const cache = eb.cache as Record<string, unknown>;
                            delete cache["no-cache"];
                            delete cache.no_cache;
                            if (Object.keys(cache).length === 0) {
                                delete eb.cache;
                            }
                        }
                        if (Object.keys(eb).length === 0) {
                            delete strippedBody.extra_body;
                        }
                    }
                    delete headers["Cache-Control"];
                }

                if (errorLower.includes("no-cache") || errorLower.includes("no_cache")) {
                    delete strippedBody.no_cache;
                    delete strippedBody["no-cache"];
                    delete strippedBody.cache;
                    if (strippedBody.extra_body && typeof strippedBody.extra_body === "object") {
                        const eb = strippedBody.extra_body as Record<string, unknown>;
                        const cache = eb.cache;
                        if (cache && typeof cache === "object") {
                            delete (cache as Record<string, unknown>)["no-cache"];
                        }
                        if (
                            cache &&
                            typeof cache === "object" &&
                            Object.keys(cache as Record<string, unknown>).length === 0
                        ) {
                            delete eb.cache;
                        }
                        if (Object.keys(eb).length === 0) {
                            delete strippedBody.extra_body;
                        }
                    }
                    delete headers["Cache-Control"];
                }

                response = await this.fetchWithRateLimit(
                    `${this.config.url}${endpoint}`,
                    {
                        method: "POST",
                        headers,
                        body: JSON.stringify(strippedBody),
                    },
                    { token }
                );
            }
        }

        if (!response.ok) {
            const errorText = await response.text();
            Logger.error(`Semutssh API error: ${response.status} ${response.statusText}`, errorText);
            throw new Error(`Semutssh API error: ${response.status} ${response.statusText}\n${errorText}`);
        }

        if (!response.body) {
            Logger.error("No response body from Semutssh API");
            throw new Error("No response body from Semutssh API");
        }

        return response.body as ReadableStream<Uint8Array>;
    }

    private getHeaders(modelId?: string, modelInfo?: LiteLLMModelInfo): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "User-Agent": this.userAgent,
        };
        if (this.config.key) {
            headers.Authorization = `Bearer ${this.config.key}`;
            headers["X-API-Key"] = this.config.key;
        }
        const isAnthropicFlag = modelId ? isAnthropicModel(modelId, modelInfo) : false;
        if (!isAnthropicFlag) {
            headers["Cache-Control"] = "no-cache";
        }
        return headers;
    }

    private withNoCacheExtraBody(body: OpenAIChatCompletionRequest): OpenAIChatCompletionRequest {
        const extraBody = body.extra_body ?? {};
        const cache = (extraBody.cache ?? {}) as Record<string, unknown>;
        cache["no-cache"] = true;
        return {
            ...body,
            extra_body: {
                ...extraBody,
                cache,
            },
        };
    }

    private async fetchWithRetry(
        url: string,
        init: RequestInit,
        options?: { retries?: number; delayMs?: number; token?: vscode.CancellationToken }
    ): Promise<Response> {
        const maxRetries = options?.retries ?? 2;
        const delayMs = options?.delayMs ?? 1000;
        let attempt = 0;
        while (true) {
            if (options?.token?.isCancellationRequested) {
                throw new Error("Operation cancelled by user");
            }

            const controller = new AbortController();
            const disposable = options?.token?.onCancellationRequested(() => controller.abort());

            try {
                const response = await fetch(url, { ...init, signal: controller.signal });
                if (response.ok || attempt >= maxRetries || response.status < 500 || response.status >= 600) {
                    return response;
                }
                attempt++;
                await this.sleep(delayMs, options?.token);
            } catch (err: unknown) {
                if (err instanceof Error && err.name === "AbortError") {
                    throw new Error("Operation cancelled by user", { cause: err });
                }
                if (attempt >= maxRetries) {
                    throw err;
                }
                attempt++;
                await this.sleep(delayMs, options?.token);
            } finally {
                disposable?.dispose();
            }
        }
    }

    async fetchWithRateLimit(
        url: string,
        init: RequestInit,
        options?: { maxTotalDelayMs?: number; initialDelayMs?: number; token?: vscode.CancellationToken }
    ): Promise<Response> {
        const maxTotalDelayMs = options?.maxTotalDelayMs ?? 120_000;
        const initialDelayMs = options?.initialDelayMs ?? 500;
        let cumulativeDelayMs = 0;
        let attempt = 0;

        while (true) {
            if (options?.token?.isCancellationRequested) {
                throw new Error("Operation cancelled by user");
            }

            const response = await this.fetchWithRetry(url, init, { token: options?.token });
            if (response.status !== 429) {
                return response;
            }

            const remaining = maxTotalDelayMs - cumulativeDelayMs;
            if (remaining <= 0) {
                return response;
            }

            const headerDelayMs = this.parseRetryAfterDelayMs(response);
            const exponentialDelayMs = initialDelayMs * Math.pow(2, attempt);
            const chosenDelay = headerDelayMs !== undefined ? headerDelayMs : exponentialDelayMs;
            const nextDelayMs = Math.min(Math.max(1, chosenDelay), remaining);

            attempt++;
            cumulativeDelayMs += nextDelayMs;
            await this.sleep(nextDelayMs, options?.token);
        }
    }

    private sleep(ms: number, token?: vscode.CancellationToken): Promise<void> {
        if (token?.isCancellationRequested) {
            return Promise.reject(new Error("Operation cancelled by user"));
        }
        return new Promise((resolve, reject) => {
            const registration = token?.onCancellationRequested(() => {
                clearTimeout(timer);
                registration?.dispose();
                reject(new Error("Operation cancelled by user"));
            });
            const timer = setTimeout(() => {
                registration?.dispose();
                resolve();
            }, ms);
        });
    }

    private parseRetryAfterDelayMs(response: Response): number | undefined {
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
            const secs = Number(retryAfter);
            if (!Number.isNaN(secs) && secs >= 0) {
                return secs * 1000;
            }
            const asDate = Date.parse(retryAfter);
            if (!Number.isNaN(asDate)) {
                const delta = asDate - Date.now();
                if (delta > 0) {
                    return delta;
                }
            }
        }
        return undefined;
    }
}
