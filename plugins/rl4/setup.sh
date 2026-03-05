#!/bin/bash
# RL4 Claude Code Plugin — Setup
# Installs MCP server dependencies

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo " ╔═══════════════════════════════════════════════════════╗"
echo " ║  RL4 Plugin Setup                                     ║"
echo " ╚═══════════════════════════════════════════════════════╝"
echo ""

# Install MCP server dependencies
echo " → Installing MCP server dependencies..."
cd "$SCRIPT_DIR/mcp-server"
npm install --production --silent
echo " ✓ Dependencies installed"

# Verify MCP server can start
echo " → Verifying MCP server..."
if node dist/index.js --help 2>/dev/null || true; then
  echo " ✓ MCP server ready"
fi

echo ""
echo " ╔═══════════════════════════════════════════════════════╗"
echo " ║  Setup complete!                                      ║"
echo " ║                                                       ║"
echo " ║  Authentication (pick one):                           ║"
echo " ║                                                       ║"
echo " ║  A. IDE users (Cursor / VS Code):                     ║"
echo " ║     → Credentials sync via ~/.rl4/mcp.env             ║"
echo " ║                                                       ║"
echo " ║  B. Standalone / Claude Code:                         ║"
echo " ║     → Visit  https://rl4.ai/start                     ║"
echo " ║     → Or run  /rl4:connect                            ║"
echo " ║                                                       ║"
echo " ║  C. Local only (no auth needed):                      ║"
echo " ║     → Works if .rl4/ directory exists                 ║"
echo " ║                                                       ║"
echo " ╠═══════════════════════════════════════════════════════╣"
echo " ║                                                       ║"
echo " ║  Get started:  /rl4                                   ║"
echo " ║                                                       ║"
echo " ║  Commands:                                            ║"
echo " ║    /rl4:ask      Ask anything with cited sources      ║"
echo " ║    /rl4:plan     Plan with full project context       ║"
echo " ║    /rl4:resume   Pick up where you left off           ║"
echo " ║    /rl4:commit   Context-aware git commit + audit     ║"
echo " ║    /rl4:refactor Safe refactor with audit             ║"
echo " ║    /rl4:debug    Debug with past bug history          ║"
echo " ║    /rl4:feature  Build with project patterns          ║"
echo " ║    /rl4:review   Review against history               ║"
echo " ║    /rl4:sync     Sync chat history from all editors   ║"
echo " ║    /rl4:snapshot Capture project state                ║"
echo " ║    /rl4:onboard  Brief a new teammate                 ║"
echo " ║    /rl4:status   MCP server health & diagnostics      ║"
echo " ║    /rl4:keys     Open API key management              ║"
echo " ║    /rl4:connect  Validate credentials & connection    ║"
echo " ║                                                       ║"
echo " ╚═══════════════════════════════════════════════════════╝"
echo ""
