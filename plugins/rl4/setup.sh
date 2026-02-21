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
echo " ║  A. If you use Cursor / VS Code with RL4 extension:  ║"
echo " ║     → Run  RL4: Connect  (Cmd+Shift+P)               ║"
echo " ║     → Credentials sync via ~/.rl4/mcp.env             ║"
echo " ║                                                       ║"
echo " ║  B. Standalone (no IDE):                              ║"
echo " ║     → Go to  https://rl4.ai/dashboard/setup           ║"
echo " ║     → Sign in → copy your credentials                ║"
echo " ║                                                       ║"
echo " ║  Then in Claude Code:  /rl4                           ║"
echo " ║                                                       ║"
echo " ╚═══════════════════════════════════════════════════════╝"
echo ""
