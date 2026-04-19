#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_DIR="${DEVCONTAINER_WORKSPACE_FOLDER:-/workspaces/semutssh-copilot}"
cd "$WORKSPACE_DIR"

npm install --include=dev
npm run compile

npm run vscode:pack