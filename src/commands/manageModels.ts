import * as vscode from "vscode";
import type { ConfigManager } from "../config/configManager";
import type { CustomModel } from "../types";

export function registerManageModelsCommand(context: vscode.ExtensionContext, configManager: ConfigManager) {
    return vscode.commands.registerCommand("semutssh.manageModels", async () => {
        const config = await configManager.getConfig();

        const choice = await vscode.window.showQuickPick(
            [
                { label: "$(add) Add Custom Model", value: "add" },
                { label: "$(list-ordered) Manage Hidden Models", value: "hidden" },
                { label: "$(star) Set Default Model", value: "default" },
            ],
            {
                title: "Semutssh — Model Management",
                placeHolder: "Choose an action",
            }
        );

        if (!choice) {
            return;
        }

        if (choice.value === "add") {
            await addCustomModel(configManager, config.customModels);
        } else if (choice.value === "hidden") {
            await manageHiddenModels(configManager, config);
        } else if (choice.value === "default") {
            await setDefaultModel(configManager, config);
        }
    });
}

async function addCustomModel(configManager: ConfigManager, existing: CustomModel[]): Promise<void> {
    const id = await vscode.window.showInputBox({
        title: "Custom Model ID",
        prompt: "Enter the model ID (e.g., semut-claude-opus-4-6)",
        ignoreFocusOut: true,
        validateInput: (v) => (!v?.trim() ? "Model ID is required" : null),
    });
    if (!id) {
        return;
    }

    const name = await vscode.window.showInputBox({
        title: "Display Name",
        prompt: "Enter a friendly display name",
        ignoreFocusOut: true,
        value: id,
    });
    if (!name) {
        return;
    }

    const contextStr = await vscode.window.showInputBox({
        title: "Context Window (tokens)",
        prompt: "Enter max context window in tokens",
        ignoreFocusOut: true,
        value: "200000",
        validateInput: (v) => {
            if (!v || isNaN(Number(v)) || Number(v) <= 0) {
                return "Enter a valid number";
            }
            return null;
        },
    });
    if (!contextStr) {
        return;
    }

    const maxOutStr = await vscode.window.showInputBox({
        title: "Max Output Tokens",
        prompt: "Enter max output tokens",
        ignoreFocusOut: true,
        value: "8192",
        validateInput: (v) => {
            if (!v || isNaN(Number(v)) || Number(v) <= 0) {
                return "Enter a valid number";
            }
            return null;
        },
    });
    if (!maxOutStr) {
        return;
    }

    const provider = await vscode.window.showQuickPick(
        [
            { label: "openai", description: "OpenAI-compatible" },
            { label: "anthropic", description: "Anthropic/Claude" },
            { label: "google", description: "Google/Gemini" },
            { label: "other", description: "Other provider" },
        ],
        {
            title: "Provider",
            placeHolder: "Select provider",
        }
    );
    if (!provider) {
        return;
    }

    const newModel: CustomModel = {
        id: id.trim(),
        name: name.trim() || id.trim(),
        contextWindow: parseInt(contextStr, 10),
        maxOutputTokens: parseInt(maxOutStr, 10),
        provider: provider.label,
    };

    const updated = existing.filter((m) => m.id !== newModel.id);
    updated.push(newModel);

    await configManager.setCustomModels(updated);
    vscode.window.showInformationMessage(`Custom model "${newModel.name}" added.`);
}

async function manageHiddenModels(configManager: ConfigManager, config: { hiddenModels: string[] }): Promise<void> {
    if (config.hiddenModels.length === 0) {
        vscode.window.showInformationMessage(
            "No hidden models. Hidden models are set automatically when you click the eye icon in the model list."
        );
        return;
    }

    const toRemove = await vscode.window.showQuickPick(
        config.hiddenModels.map((m) => ({ label: m, picked: false })),
        {
            title: "Select Hidden Models to Remove",
            canPickMany: true,
            placeHolder: "Select models to unhide",
        }
    );

    if (!toRemove || toRemove.length === 0) {
        return;
    }

    const removedSet = new Set(toRemove.map((m) => m.label));
    const remaining = config.hiddenModels.filter((m) => !removedSet.has(m));

    await configManager.setHiddenModels(remaining);
    vscode.window.showInformationMessage(`${toRemove.length} model(s) unhidden.`);
}

async function setDefaultModel(
    configManager: ConfigManager,
    config: { customModels: CustomModel[]; defaultModel: string }
): Promise<void> {
    const allModelIds = [...config.customModels.map((m) => m.id)];

    if (allModelIds.length === 0) {
        vscode.window.showInformationMessage("No custom models available. Add a custom model first.");
        return;
    }

    const selected = await vscode.window.showQuickPick(
        allModelIds.map((id) => ({ label: id, picked: id === config.defaultModel })),
        {
            title: "Select Default Model",
            canPickMany: false,
            placeHolder: "Choose the default model",
        }
    );

    if (!selected) {
        return;
    }

    await configManager.setDefaultModel(selected.label);
    vscode.window.showInformationMessage(`Default model set to: ${selected.label}`);
}
