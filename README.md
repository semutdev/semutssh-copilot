# Semutssh Copilot

Integrates **SemutSSH AI API** into VS Code Copilot Chat via LiteLLM-compatible endpoints.

> Bring your own AI models into VS Code Copilot Chat — powered by SemutSSH.

---

## Features

- **Any model from SemutSSH** — Use Claude, GPT, Gemini, and more directly in Copilot Chat
- **Streaming responses** — Real-time, streaming output like native Copilot models
- **Tool calling support** — Full function calling capability
- **Custom models** — Add your own model configurations
- **Secure API key storage** — Stored in VS Code's encrypted SecretStorage

---

## Requirements

- **VS Code 1.99.0+**
- **GitHub Copilot** subscription (Free or Paid Individual plans work)
- **SemutSSH API key** — Get yours at https://semutssh.com

---

## Installation

### Option 1: Install from VSIX (Recommended)

1. Download the latest `.vsix` file from [GitHub Releases](https://github.com/semutdev/semutssh-copilot/releases)
2. In VS Code: `F1` → **Extensions: Install from VSIX**
3. Select the downloaded `.vsix` file
4. Reload VS Code

### Option 2: Build from Source

```bash
# Clone the repo
git clone https://github.com/semutdev/semutssh-copilot.git
cd semutssh-copilot

# Install dependencies
npm install

# Build
npm run package

# Install the .vsix
# (In VS Code: F1 → Extensions: Install from VSIX → select the .vsix file)
```

---

## Setup

### 1. Configure API Key

- `F1` → type `Semutssh: Configure`
- **Base URL**: `https://ai.semutssh.com/v1` (default)
- **API Key**: paste your SemutSSH API key

### 2. Add Custom Models

Since the API key may only have access to `/chat/completions` (not `/model/info`), add models manually:

- `F1` → `Semutssh: Manage Models` → `Add Custom Model`
- Fill in model details (ID, name, context window, etc.)

Example — adding `glm-5`:
```
Model ID:     glm-5
Display Name: GLM-5
Context Window: 200000
Max Output Tokens: 8192
Provider: other
```

### 3. Check Connection

- `F1` → `Semutssh: Check Connection`
- Should show success with latency

### 4. Start Chatting

- Open Copilot Chat: `F1` → `Chat: Open Chat`
- Select a model from the Semutssh section in the model picker
- Start chatting!

---

## Available Commands

| Command | What It Does |
|---------|--------------|
| `Semutssh: Configure` | Set Base URL and API key |
| `Semutssh: Manage Models` | Add/remove custom models or manage hidden models |
| `Semutssh: Show Available Models` | View all available models |
| `Semutssh: Reload Models` | Refresh model list |
| `Semutssh: Check Connection` | Test connectivity to SemutSSH API |
| `Semutssh: Reset All Configuration` | Clear all settings |

---

## Configuration

Manually edit settings via `F1` → `Preferences: Open User Settings (JSON)`:

```json
{
  "semutssh.baseUrl": "https://ai.semutssh.com/v1",
  "semutssh.apiKeySecretRef": "default",
  "semutssh.customModels": [
    {
      "id": "glm-5",
      "name": "GLM-5",
      "contextWindow": 200000,
      "maxOutputTokens": 8192,
      "provider": "other"
    }
  ],
  "semutssh.hiddenModels": [],
  "semutssh.defaultModel": ""
}
```

---

## Troubleshooting

### "Provider registered successfully" not in logs?

- Make sure you're using **VS Code 1.99.0+**
- Check `Help → About` to verify your version
- Update VS Code if needed: https://code.visualstudio.com/download

### "403 Forbidden" on Check Connection?

- Your API key may not have access to `/model/info` endpoint
- This is normal — models will still work via `/chat/completions`
- Add custom models manually via `Semutssh: Manage Models`

### Models not appearing in Copilot Chat?

1. `F1` → `Semutssh: Reload Models`
2. Open Copilot Chat (`F1` → `Chat: Open Chat`)
3. Click the model picker dropdown at the top
4. Look for **Semutssh** section

### Chat returns error?

- Check Output panel: `View → Output → Semutssh Copilot`
- Verify API key is correct: `F1` → `Semutssh: Configure`
- Make sure the model ID is valid for your SemutSSH account

---

## Development

```bash
# Clone
git clone https://github.com/semutdev/semutssh-copilot.git
cd semutssh-copilot

# Install
npm install

# Build
npm run compile

# Lint
npm run lint

# Package
npm run package
```

Press `F5` in VS Code to debug in Extension Development Host.

---

## Acknowledgments

This project is a fork of [LiteLLM Connector for Copilot](https://github.com/gethnet/litellm-connector-copilot) by [GethNet](https://github.com/gethnet). The original project provides LiteLLM proxy integration for VS Code Copilot Chat — this fork adapts it specifically for the SemutSSH API.

---

## License

MIT

---

## Links

- **GitHub**: https://github.com/semutdev/semutssh-copilot
- **Issues**: https://github.com/semutdev/semutssh-copilot/issues
- **SemutSSH API**: https://semutssh.com
