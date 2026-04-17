import * as vscode from "vscode";
import type { CustomModel, SemutsshConfig } from "../types";

export class ConfigManager {
    private static readonly BASE_URL_KEY = "semutssh.baseUrl";
    private static readonly API_KEY_KEY = "semutssh.apiKey";
    private static readonly API_KEY_SECRET_REF_KEY = "semutssh.apiKeySecretRef";
    private static readonly DEFAULT_API_KEY_SECRET_REF = "default";
    private static readonly CUSTOM_MODELS_KEY = "semutssh.customModels";
    private static readonly HIDDEN_MODELS_KEY = "semutssh.hiddenModels";
    private static readonly DEFAULT_MODEL_KEY = "semutssh.defaultModel";

    constructor(private readonly secrets: vscode.SecretStorage) {}

    private getApiKeySecretStorageKey(ref: string): string {
        return `${ConfigManager.API_KEY_KEY}.${ref}`;
    }

    async getConfig(): Promise<SemutsshConfig> {
        const url = vscode.workspace
            .getConfiguration()
            .get<string>(ConfigManager.BASE_URL_KEY, "https://ai.semutssh.com/v1")
            .trim();

        const apiKeySecretRef = vscode.workspace
            .getConfiguration()
            .get<string>(ConfigManager.API_KEY_SECRET_REF_KEY, ConfigManager.DEFAULT_API_KEY_SECRET_REF)
            .trim();
        const key = await this.secrets.get(this.getApiKeySecretStorageKey(apiKeySecretRef));

        const customModels = (vscode.workspace
            .getConfiguration()
            .get<CustomModel[]>(ConfigManager.CUSTOM_MODELS_KEY, []) ?? [])
            .filter((m) => m && m.id && m.id.trim().length > 0);

        const hiddenModels = vscode.workspace
            .getConfiguration()
            .get<string[]>(ConfigManager.HIDDEN_MODELS_KEY, []);

        const defaultModel = vscode.workspace
            .getConfiguration()
            .get<string>(ConfigManager.DEFAULT_MODEL_KEY, "")
            .trim();

        return {
            url,
            key: key || undefined,
            customModels,
            hiddenModels,
            defaultModel,
        };
    }

    async setConfig(config: { url: string; key?: string }): Promise<void> {
        const settings = vscode.workspace.getConfiguration();
        await settings.update(
            ConfigManager.BASE_URL_KEY,
            config.url ? config.url.trim() : "",
            vscode.ConfigurationTarget.Global
        );

        const apiKeySecretRef = settings
            .get<string>(ConfigManager.API_KEY_SECRET_REF_KEY, ConfigManager.DEFAULT_API_KEY_SECRET_REF)
            .trim();
        const secretKey = this.getApiKeySecretStorageKey(apiKeySecretRef);
        if (config.key) {
            await this.secrets.store(secretKey, config.key);
        } else {
            await this.secrets.delete(secretKey);
        }
    }

    async setCustomModels(models: CustomModel[]): Promise<void> {
        const settings = vscode.workspace.getConfiguration();
        await settings.update(
            ConfigManager.CUSTOM_MODELS_KEY,
            models,
            vscode.ConfigurationTarget.Global
        );
    }

    async setHiddenModels(models: string[]): Promise<void> {
        const settings = vscode.workspace.getConfiguration();
        await settings.update(
            ConfigManager.HIDDEN_MODELS_KEY,
            models,
            vscode.ConfigurationTarget.Global
        );
    }

    async setDefaultModel(modelId: string): Promise<void> {
        const settings = vscode.workspace.getConfiguration();
        await settings.update(
            ConfigManager.DEFAULT_MODEL_KEY,
            modelId.trim(),
            vscode.ConfigurationTarget.Global
        );
    }

    async isConfigured(): Promise<boolean> {
        const config = await this.getConfig();
        return !!config.url;
    }

    async cleanupAllConfiguration(): Promise<void> {
        try {
            const settings = vscode.workspace.getConfiguration();
            const apiKeySecretRef = settings
                .get<string>(ConfigManager.API_KEY_SECRET_REF_KEY, ConfigManager.DEFAULT_API_KEY_SECRET_REF)
                .trim();
            await this.secrets.delete(this.getApiKeySecretStorageKey(apiKeySecretRef));

            try {
                await settings.update(ConfigManager.BASE_URL_KEY, "", vscode.ConfigurationTarget.Global);
                await settings.update(
                    ConfigManager.API_KEY_SECRET_REF_KEY,
                    undefined,
                    vscode.ConfigurationTarget.Global
                );
                await settings.update(ConfigManager.CUSTOM_MODELS_KEY, [], vscode.ConfigurationTarget.Global);
                await settings.update(ConfigManager.HIDDEN_MODELS_KEY, [], vscode.ConfigurationTarget.Global);
                await settings.update(ConfigManager.DEFAULT_MODEL_KEY, "", vscode.ConfigurationTarget.Global);
            } catch (err) {
                console.warn("[Semutssh] Error clearing configuration settings:", err);
            }
        } catch (err) {
            console.error("[Semutssh] Error during cleanup:", err);
        }
    }
}
