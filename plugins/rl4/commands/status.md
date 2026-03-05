---
description: Show RL4 MCP server status and health
---

# RL4: Status

Check the RL4 MCP server health and display a diagnostic dashboard.

## Step 1: Health Check

Run this command via Bash to check the MCP server:

```bash
curl -s --max-time 2 http://127.0.0.1:17340/health 2>/dev/null || echo '{"error":"MCP server not responding"}'
```

## Step 2: Parse & Display

Parse the JSON response and display:

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 STATUS                                                         ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║  Server       {status}         PID         {pid}                    ║
 ║  Context      {context_mode}   Memory      {memory_scope}           ║
 ║  Personal Sync {personal_sync_status}                               ║
 ║  Remote       {remote_configured ? "Connected" : "Not configured"}  ║
 ║  Dist Hash    {dist_hash}      Match: {expected_dist_hash_match}    ║
 ║  Uptime       {uptime_s}s                                           ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║  CIRCUIT BREAKER                                                    ║
 ║  Status: {circuit_breaker.open ? "⚠ OPEN" : "✓ Closed"}            ║
 ║  Errors: {circuit_breaker.consecutive_errors}                       ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Step 3: Actionable CTAs

Based on the response, suggest next actions:

- If `personal_sync_status` is `no_key`: suggest "Run `/rl4:keys` to manage your API keys"
- If `expected_dist_hash_match` is `false`: warn "⚠ Stale binary detected — restart your editor or run RL4: Connect"
- If `circuit_breaker.open` is `true`: warn "⚠ Circuit breaker open — cloud features temporarily disabled"
- If `degraded` is `true`: warn "⚠ Running in degraded mode"
- If server is not responding: suggest "MCP server is down. Open your editor (Cursor/VS Code) and run RL4: Connect, or visit https://rl4.ai/dashboard/setup"
