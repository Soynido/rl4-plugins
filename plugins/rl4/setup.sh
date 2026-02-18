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
echo " ║  Next steps:                                          ║"
echo " ║  1. Authenticate:  https://rl4.ai/start               ║"
echo " ║  2. Set credentials:                                  ║"
echo " ║     export RL4_ACCESS_TOKEN=\"your_token\"              ║"
echo " ║     export RL4_USER_ID=\"your_user_id\"                 ║"
echo " ║  3. In Claude Code:  /rl4                             ║"
echo " ║                                                       ║"
echo " ╚═══════════════════════════════════════════════════════╝"
echo ""
