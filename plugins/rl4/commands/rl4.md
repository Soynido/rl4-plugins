# RL4 — Cross-LLM Memory

Activate RL4 context for this session. Follow these steps precisely:

## Step 1: ASCII Banner

Print this exact banner:

```
 ╔═══════════════════════════════════════════════════════════╗
 ║                                                           ║
 ║   ██████╗ ██╗     ██╗  ██╗                               ║
 ║   ██╔══██╗██║     ██║  ██║                               ║
 ║   ██████╔╝██║     ███████║                               ║
 ║   ██╔══██╗██║     ╚════██║                               ║
 ║   ██║  ██║███████╗     ██║                               ║
 ║   ╚═╝  ╚═╝╚══════╝     ╚═╝                               ║
 ║                                                           ║
 ║   Cross-LLM memory for your codebase                     ║
 ║   ─────────────────────────────────────                   ║
 ║   Context that follows you: Cursor ↔ VS Code ↔ CLI       ║
 ║                                                           ║
 ╚═══════════════════════════════════════════════════════════╝
```

## Step 2: Workspace Detection

Call `set_workspace("current")` to bind the local `.rl4/` directory.

If this succeeds, proceed to Step 3.

If this fails (401, no token, or error):
1. Print:
```
 ┌─ AUTH REQUIRED ──────────────────────────────────────────┐
 │                                                           │
 │  RL4 needs authentication to access cloud features.       │
 │                                                           │
 │  1. Open:  https://rl4.ai/start                          │
 │  2. Sign in with GitHub                                   │
 │  3. Select your repo → analysis runs (~15s)               │
 │  4. Copy your credentials from the "Claude Code" tab      │
 │                                                           │
 │  Then set in your shell:                                  │
 │    export RL4_ACCESS_TOKEN="your_token"                   │
 │    export RL4_USER_ID="your_user_id"                      │
 │                                                           │
 │  Or add to ~/.zshrc / ~/.bashrc for persistence.          │
 │                                                           │
 └───────────────────────────────────────────────────────────┘
```
2. **Fallback**: Try reading `.rl4/evidence.md` and `.rl4/timeline.md` directly using the Read tool. If they exist, continue to Step 3 with local-only mode. If they don't exist, stop here.

## Step 3: Load Context & Show Dashboard

Call `get_evidence` and `get_timeline` in parallel to load the workspace context.

Then parse the results and display an ASCII dashboard:

```
 ┌─ WORKSPACE DASHBOARD ────────────────────────────────────┐
 │                                                           │
 │  Project:    {project_name from evidence or git remote}   │
 │  Context:    {local | cloud}                              │
 │  Last sync:  {date from latest timeline entry}            │
 │                                                           │
 │  ── Evidence ──────────────────────────────────────────   │
 │  Sessions:     {count from evidence.md}                   │
 │  Files tracked: {count from evidence.md}                  │
 │  Chat threads:  {count from evidence.md}                  │
 │  Decisions:     {count from evidence.md}                  │
 │                                                           │
 │  ── Timeline (last 5 entries) ──────────────────────────  │
 │  {date} │ {summary line}                                  │
 │  {date} │ {summary line}                                  │
 │  {date} │ {summary line}                                  │
 │  {date} │ {summary line}                                  │
 │  {date} │ {summary line}                                  │
 │                                                           │
 │  ── Quick Stats ────────────────────────────────────────  │
 │  ▓▓▓▓▓▓▓▓▓▓▓▓░░░░ 73% code coverage                     │
 │  {lines_added}+ / {lines_removed}- lines this week       │
 │  {commit_count} commits tracked                           │
 │                                                           │
 └───────────────────────────────────────────────────────────┘
```

**Parsing rules for the dashboard:**
- From `evidence.md`: Look for "## Sessions" (count entries), "## Files" or file tables, "## Chat" threads count, decisions count
- From `timeline.md`: Extract the last 5 `### YYYY-MM-DD` entries and their first summary line
- If a field is unavailable, show `—` instead of fabricating data
- Lines added/removed: look for `+N / -N` patterns in recent timeline entries
- Commit count: count `commit` mentions in timeline or evidence

## Step 4: Available Commands

Print:
```
 ┌─ AVAILABLE TOOLS ────────────────────────────────────────┐
 │                                                           │
 │  search_context("query")   Search all evidence (RAG)     │
 │  rl4_ask("question")       Ask with cited sources        │
 │  get_evidence              Full evidence pack             │
 │  get_timeline              Project history journal        │
 │  get_decisions             Decision log with confidence   │
 │  get_intent_graph          Intent chains & trajectories   │
 │  search_chats("query")     Search chat history only       │
 │  search_cli("query")       Search CLI command history     │
 │                                                           │
 │  ── Cross-LLM Transfer ─────────────────────────────────  │
 │  Everything in .rl4/ is shared across all editors.        │
 │  Switch to Cursor or VS Code anytime — context persists.  │
 │                                                           │
 └───────────────────────────────────────────────────────────┘
```

## Step 5: Ready

Print:
```
 ═══════════════════════════════════════════════════════════
   RL4 READY — Ask me anything about your codebase.
 ═══════════════════════════════════════════════════════════
```

Then wait for the user's first question. Always cite sources (file, line, date) in answers.

---

## Fallback when MCP returns 401 or error

If `get_evidence`/`get_timeline`/`search_context` return **401 (token expired)** or any error:

1. **Tell the user**: "Your RL4 token has expired. Refresh it:"
```
  1. Open https://rl4.ai/start → sign in
  2. Copy new credentials from "Claude Code" tab
  3. export RL4_ACCESS_TOKEN="new_token"
```
2. **Offer fallback**: "Meanwhile, I can read `.rl4/evidence.md` and `.rl4/timeline.md` directly from disk." Then use the Read tool. Cite source as `[.rl4/evidence.md]` or `[.rl4/timeline.md]`.

---

## Cross-LLM Context Transfer

RL4's `.rl4/` directory is the **single source of truth** shared across all editors:

| Editor | Writes to .rl4/ | Reads from .rl4/ |
|--------|-----------------|-------------------|
| Cursor | snapshots, evidence, chat | MCP tools |
| VS Code | snapshots, evidence, chat | MCP tools |
| Claude Code | timeline entries, decisions | MCP tools + Read |
| Codex/Gemini | — | MCP tools + Read |

When a user switches editors, **zero setup is needed** — the MCP server reads the same `.rl4/` directory regardless of which LLM wrote to it.
