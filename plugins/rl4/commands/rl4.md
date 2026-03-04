---
description: Activate RL4 cross-LLM memory with project dashboard
---

# RL4 — Activate Cross-LLM Memory

## Step 1: Banner

Print this exact banner:

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║                                                                      ║
 ║   ██████╗ ██╗     ██╗  ██╗                                          ║
 ║   ██╔══██╗██║     ██║  ██║    Cross-LLM Memory                      ║
 ║   ██████╔╝██║     ███████║    ─────────────────                      ║
 ║   ██╔══██╗██║     ╚════██║    Context that follows you everywhere    ║
 ║   ██║  ██║███████╗     ██║                                          ║
 ║   ╚═╝  ╚═╝╚══════╝     ╚═╝                                          ║
 ║                                                                      ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Step 2: Bind Workspace

Call `set_workspace("current")` to activate the local `.rl4/` directory.

If this fails (401, no token, or error):
```
 ┌─ AUTH REQUIRED ──────────────────────────────────────────────────────┐
 │                                                                       │
 │  RL4 needs authentication for cloud features.                         │
 │                                                                       │
 │  1. Open:  https://rl4.ai/start                                      │
 │  2. Sign in with GitHub                                               │
 │  3. Copy credentials from the "Claude Code" tab                       │
 │                                                                       │
 │  Or: RL4 works locally without auth. Try reading .rl4/ directly.      │
 │                                                                       │
 └───────────────────────────────────────────────────────────────────────┘
```
Fallback: read `.rl4/evidence.md` and `.rl4/timeline.md` directly. If they exist, continue in local-only mode.

## Step 3: Load Context & Dashboard

Call `get_evidence` and `get_timeline` in parallel. Parse the results and render:

```
 ╠══════════════════════════════════════════════════════════════════════╣
 ║  PROJECT    {name}              CONTEXT  {local|cloud}              ║
 ║  LAST SYNC  {date}             STREAK   {N} days                    ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  Sessions     {N}  ████████████░░░░░░░░                              ║
 ║  Files        {N}  ██████████████████░░                              ║
 ║  Decisions    {N}  ████████░░░░░░░░░░░░                              ║
 ║  Chat threads {N}  ██████████████░░░░░░                              ║
 ║                                                                      ║
```

**Parsing rules:**
- Sessions count: count session entries in evidence
- Files: count unique file paths
- Decisions: count decision entries
- Chat threads: count thread entries
- Progress bars: 20 chars wide, `█` proportional to value/max, `░` for remainder
- If a metric is unavailable, show `—`

## Step 4: Show Commands

```
 ╠══════════════════════════════════════════════════════════════════════╣
 ║  COMMANDS                                                            ║
 ║  ┌────────────────┬──────────────────────────────────────────────┐   ║
 ║  │ /rl4:ask       │ Ask anything — cited answers from history    │   ║
 ║  │ /rl4:plan      │ Plan any task with full project context      │   ║
 ║  │ /rl4:resume    │ Pick up where you left off                   │   ║
 ║  │ /rl4:commit    │ Context-aware git commit with audit          │   ║
 ║  │ /rl4:refactor  │ Safe refactor with pre/post audit            │   ║
 ║  │ /rl4:debug     │ Debug with past bug history                  │   ║
 ║  │ /rl4:feature   │ New feature with context-aware planning      │   ║
 ║  │ /rl4:review    │ Review changes against project history       │   ║
 ║  │ /rl4:sync      │ Sync chat history from all editors           │   ║
 ║  │ /rl4:snapshot  │ Capture full project state                   │   ║
 ║  │ /rl4:onboard   │ Onboard a teammate with shared context      │   ║
 ║  └────────────────┴──────────────────────────────────────────────┘   ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Step 5: Ready

```
   RL4 READY — Your AI remembers everything.
```

Then wait for the user's first question. Always cite sources in answers.

## Cross-LLM Context

RL4's `.rl4/` directory is shared across all editors:

| Editor | Writes to .rl4/ | Reads from .rl4/ |
|--------|-----------------|-------------------|
| Cursor | snapshots, evidence, chat | MCP tools |
| VS Code | snapshots, evidence, chat | MCP tools |
| Claude Code | timeline entries, decisions | MCP tools + Read |
