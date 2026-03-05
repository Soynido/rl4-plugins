---
description: Validate RL4 connection and credentials
---

# RL4: Connect

Validate that RL4 credentials are configured and the MCP server is reachable.

## Step 1: Check Credentials

Read the RL4 credentials file:

```bash
cat ~/.rl4/mcp.env 2>/dev/null || echo "NOT_FOUND"
```

Parse the output:
- If `NOT_FOUND`: credentials are missing
- If file exists: check that `RL4_ACCESS_TOKEN` is present and non-empty

## Step 2: Check MCP Server

```bash
curl -s --max-time 2 http://127.0.0.1:17340/health 2>/dev/null || echo '{"error":"not_running"}'
```

## Step 3: Display Status

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 CONNECTION                                                     ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║  Credentials  {found ? "✓ Found" : "✗ Missing"}                    ║
 ║  MCP Server   {running ? "✓ Running" : "✗ Not running"}            ║
 ║  Auth Token   {has_token ? "✓ Present" : "✗ Missing"}              ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Step 4: Fix Issues

If credentials are missing or token is absent:
1. Print: "Opening RL4 authentication..."
2. Open the auth page:

```bash
open "https://rl4.ai/auth/cursor?editor=claude-code" 2>/dev/null || xdg-open "https://rl4.ai/auth/cursor?editor=claude-code" 2>/dev/null || echo "Visit: https://rl4.ai/auth/cursor?editor=claude-code"
```

3. Print: "After signing in, your credentials will sync to ~/.rl4/mcp.env via your IDE (Cursor/VS Code). Then restart Claude Code to pick up the new token."

If MCP server is not running:
- Print: "The MCP server starts when you open a workspace in Cursor or VS Code with the RL4 extension installed. Alternatively, visit https://rl4.ai/dashboard/setup for setup instructions."

If everything is OK:
- Print: "✓ RL4 is fully connected. Run `/rl4` to activate cross-LLM memory."
