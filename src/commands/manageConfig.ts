import * as vscode from "vscode";
import type { ConfigManager } from "../config/configManager";
import type { SemutsshChatProvider } from "../providers";
import { SemutsshClient } from "../adapters/semutsshClient";

function createConfigHandler(configManager: ConfigManager, provider?: SemutsshChatProvider) {
    return async () => {
        const config = await configManager.getConfig();

        const baseUrl = await vscode.window.showInputBox({
            title: `Semutssh Base URL`,
            prompt: config.url
                ? "Update your Semutssh base URL"
                : "Enter your Semutssh base URL (e.g., https://ai.semutssh.com/v1)",
            ignoreFocusOut: true,
            value: config.url,
            placeHolder: "http://localhost:4000",
        });

        if (baseUrl === undefined) {
            return;
        }

        let apiKey = await vscode.window.showInputBox({
            title: `Semutssh API Key`,
            prompt: config.key
                ? "Update your Semutssh API key"
                : "Enter your Semutssh API key (leave empty if not required)",
            ignoreFocusOut: true,
            password: true,
            // Show empty to avoid leaking in plain text.
            value: "",
            placeHolder: config.key ? "••••••••••••••••" : "Enter API Key",
        });

        if (apiKey === undefined) {
            return;
        }

        // If user enters the magic string, show the actual API key in plain text
        if (apiKey.trim() === "thisisunsafe" && config.key) {
            apiKey = await vscode.window.showInputBox({
                title: `Semutssh API Key`,
                prompt: "Your API key (unmasked)",
                ignoreFocusOut: true,
                password: false,
                value: config.key,
                placeHolder: "Your API key",
            });

            if (apiKey === undefined) {
                return;
            }
        }

        // If user didn't change the value (left it blank/placeholder), keep the old key
        const newKey = apiKey.trim();
        const finalKey = newKey === "" ? config.key : newKey || undefined;

        await configManager.setConfig({
            url: baseUrl.trim(),
            key: finalKey,
        });

        // Trigger a model discovery refresh if a provider is available
        if (provider) {
            try {
                provider.clearModelCache();
                await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
                provider.refreshModelInformation();
            } catch (err) {
                console.error("Failed to refresh models after config change", err);
            }
        }

        vscode.window.showInformationMessage(`Semutssh configuration saved.`);
    };
}

export function registerManageConfigCommand(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    provider?: SemutsshChatProvider
) {
    return vscode.commands.registerCommand("semutssh.configure", createConfigHandler(configManager, provider));
}

export function registerShowModelsCommand(provider: SemutsshChatProvider) {
    return vscode.commands.registerCommand("semutssh.showModels", async () => {
        const models = provider.getLastKnownModels();
        if (!models.length) {
            vscode.window.showInformationMessage(
                "No cached models yet. Run 'LiteLLM: Reload Models' (or open the provider settings) to fetch models from LiteLLM."
            );
            return;
        }

        // Show a quick pick list with model ids (copy-friendly)
        const picked = await vscode.window.showQuickPick(
            models
                .slice()
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((m) => ({
                    label: m.id,
                    description: m.name !== m.id ? m.name : undefined,
                    detail: m.tooltip,
                })),
            {
                title: "Semutssh: Available Models (cached)",
                placeHolder: "Select a model id to copy to clipboard",
                matchOnDescription: true,
                matchOnDetail: true,
            }
        );

        if (!picked) {
            return;
        }

        await vscode.env.clipboard.writeText(picked.label);
        vscode.window.showInformationMessage(`Copied model id: ${picked.label}`);
    });
}

export function registerReloadModelsCommand(provider: SemutsshChatProvider) {
    return vscode.commands.registerCommand("semutssh.reloadModels", async () => {
        provider.clearModelCache();
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Semutssh: Reloading models",
                cancellable: false,
            },
            async () => {
                // Trigger a fresh discovery request. VS Code will call discovery when it needs it,
                // but we do it proactively so completions pick up new models immediately.
                await provider.provideLanguageModelChatInformation(
                    { silent: true },
                    new vscode.CancellationTokenSource().token
                );
            }
        );

        const count = provider.getLastKnownModels().length;
        vscode.window.showInformationMessage(`Semutssh: Reloaded ${count} models.`);
    });
}

export function registerCheckConnectionCommand(configManager: ConfigManager) {
    return vscode.commands.registerCommand("semutssh.checkConnection", async () => {
        const config = await configManager.getConfig();
        if (!config.url) {
            vscode.window.showErrorMessage("Semutssh base URL not configured.");
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Semutssh: Checking connection",
                cancellable: true,
            },
            async (_progress, token) => {
                const client = new SemutsshClient(config, "semutssh-copilot");
                try {
                    const result = await client.checkConnection(token);
                    vscode.window.showInformationMessage(
                        `Semutssh: Connection successful! Latency: ${result.latencyMs}ms. Found ${result.modelCount} models.`
                    );
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Semutssh: Connection failed: ${msg}`);
                }
            }
        );
    });
}

export function registerResetConfigCommand(configManager: ConfigManager, provider?: SemutsshChatProvider) {
    return vscode.commands.registerCommand("semutssh.reset", async () => {
        const confirmed = await vscode.window.showWarningMessage(
            "Are you sure you want to reset ALL Semutssh configuration? This will clear your Base URL, API Key, and all custom settings.",
            { modal: true },
            "Reset All"
        );

        if (confirmed === "Reset All") {
            try {
                await configManager.cleanupAllConfiguration();
                if (provider) {
                    provider.clearModelCache();
                    //provider.refreshModelInformation();
                }
                vscode.window.showInformationMessage("Semutssh configuration has been reset.");
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Semutssh: Reset failed: ${msg}`);
            }
        }
    });
}
