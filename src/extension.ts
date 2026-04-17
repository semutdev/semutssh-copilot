import * as vscode from "vscode";
import { SemutsshChatProvider } from "./providers";
import { ConfigManager } from "./config/configManager";
import {
    registerManageConfigCommand,
    registerReloadModelsCommand,
    registerShowModelsCommand,
    registerCheckConnectionCommand,
    registerResetConfigCommand,
} from "./commands/manageConfig";
import { registerManageModelsCommand } from "./commands/manageModels";
import { Logger } from "./utils/logger";

let configManagerInstance: ConfigManager | undefined;

export function activate(context: vscode.ExtensionContext) {
    Logger.initialize(context);
    Logger.info("Activating Semutssh Copilot...");

    let ua = "semutssh-vscode-chat/unknown VSCode/unknown";
    try {
        const ext = vscode.extensions.getExtension("semutdev.semutssh-copilot");
        const extVersion = ext?.packageJSON?.version ?? "unknown";
        const vscodeVersion = vscode.version;
        ua = `semutssh-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;
    } catch (uaErr) {
        Logger.error("Failed to build UA", uaErr);
    }

    configManagerInstance = new ConfigManager(context.secrets);
    const configManager = configManagerInstance;
    const chatProvider = new SemutsshChatProvider(context.secrets, ua);

    void configManager.getConfig().then(async () => {
        // Register the provider
        try {
            Logger.info("Registering LanguageModelChatProvider...");
            const registration = vscode.lm.registerLanguageModelChatProvider(
                "semutssh",
                chatProvider as unknown as vscode.LanguageModelChatProvider
            );
            if (registration) {
                context.subscriptions.push(registration);
                Logger.info("Provider registered successfully.");
            } else {
                Logger.error("registerLanguageModelChatProvider returned undefined/null");
            }
        } catch (err) {
            Logger.error("Failed to register provider", err);
        }

        // Register commands
        try {
            context.subscriptions.push(registerManageConfigCommand(context, configManager, chatProvider));
            context.subscriptions.push(registerShowModelsCommand(chatProvider));
            context.subscriptions.push(registerReloadModelsCommand(chatProvider));
            context.subscriptions.push(registerCheckConnectionCommand(configManager));
            context.subscriptions.push(registerResetConfigCommand(configManager, chatProvider));
            context.subscriptions.push(registerManageModelsCommand(context, configManager));
            Logger.info("Commands registered.");
        } catch (cmdErr) {
            Logger.error("Failed to register commands", cmdErr);
        }

        // Check if configured
        const configured = await configManager.isConfigured();
        if (!configured) {
            Logger.info("Extension not configured. Prompting user...");
            vscode.window
                .showInformationMessage(
                    "Semutssh Copilot needs configuration. Configure your API Key to continue.",
                    "Configure"
                )
                .then((selection) => {
                    if (selection === "Configure") {
                        vscode.commands.executeCommand("semutssh.configure");
                    }
                });
        }
    });
}

export async function deactivate() {
    // Intentionally do not clear configuration on deactivate.
}
