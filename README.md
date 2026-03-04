# RL4 — Claude Code Plugin

**Your AI forgets. RL4 doesn't.**

A persistent, proof-based memory layer for AI-native development. Context that follows you seamlessly across **Cursor, VS Code, and Claude Code CLI**.

```
 ██████╗ ██╗     ██╗  ██╗
 ██╔══██╗██║     ██║  ██║
 ██████╔╝██║     ███████║
 ██╔══██╗██║     ╚════██║
 ██║  ██║███████╗     ██║
 ╚═╝  ╚═╝╚══════╝     ╚═╝
```

## Why RL4?

Every time you switch editors, start a new chat, or come back to a project after a break — your AI starts from zero. No memory of what you built, why you made that decision, or what broke last time.

**RL4 fixes this.** It captures your development activity and makes it instantly available to any LLM, in any editor.

- No more re-explaining your architecture
- No more lost decisions and forgotten context
- No more "I don't have access to previous conversations"

## Install (Step by Step)

### 1. Add the RL4 marketplace

In Claude Code, run:

```
/plugin marketplace add Soynido/rl4-plugins
```

This registers the RL4 marketplace. You only need to do this once.

### 2. Install the RL4 plugin

```
/plugin install rl4@rl4-plugins
```

This installs the plugin with all commands, skills, and the MCP server.

### 3. Activate RL4

```
/rl4
```

That's it. RL4 shows you a dashboard with your project stats and gives you full access to your development memory.

> **Tip**: If commands don't appear after install, try: `rm -rf ~/.claude/plugins/cache` then restart Claude Code and reinstall.

## Commands

RL4 gives you **12 commands** that chain 24 MCP tools automatically — you never need to call raw tools. Plus, an intelligent auto-recommend system suggests the right command based on your prompt.

| Command | What it does |
|---------|-------------|
| `/rl4` | Activate RL4 — dashboard with project stats and onboarding |
| `/rl4:ask` | Ask anything about your project — cited answers from all editors |
| `/rl4:plan` | Plan any task with full project context (decisions, AVOID patterns, coupling) |
| `/rl4:resume` | Pick up where you left off — last session, hot files, next steps |
| `/rl4:commit` | Context-aware git commit — audits changes, generates enriched message, indexes into evidence |
| `/rl4:refactor` | Safe refactoring — pre-edit briefing from past mistakes, post-edit audit |
| `/rl4:debug` | Debug with history — find similar bugs that were already solved |
| `/rl4:feature` | Build a feature informed by project patterns and past decisions |
| `/rl4:review` | Review changes against project history — catch repeated mistakes |
| `/rl4:sync` | Sync chat history from Cursor, VS Code, and Claude Code into RL4 evidence |
| `/rl4:snapshot` | Capture full project state — evidence, timeline, skills, git history |
| `/rl4:onboard` | Generate a project briefing for new team members from real history |

### Quick examples

```
/rl4:ask what did we work on yesterday?
/rl4:plan migrate the auth system to OAuth2
/rl4:commit auth refactor
/rl4:refactor src/app.ts split into modules
/rl4:debug ERR_MODULE_NOT_FOUND when starting the server
/rl4:sync
/rl4:resume
```

## How It Works

### 1. Your AI writes to `.rl4/`
Every editor (Cursor, VS Code, Claude Code) writes development activity to a shared `.rl4/` directory in your project root — chat history, file events, decisions, timeline.

### 2. MCP tools read from `.rl4/`
The RL4 MCP server exposes 24 tools that search, analyze, and cross-reference your development history. The 10 commands above chain these tools automatically.

### 3. Cross-LLM memory
Switch from Cursor to Claude Code to VS Code — your context follows. The `.rl4/` directory is the shared memory layer. No sync needed.

| Editor | Writes to .rl4/ | Reads from .rl4/ |
|--------|-----------------|-------------------|
| Cursor | snapshots, evidence, chat | MCP tools |
| VS Code | snapshots, evidence, chat | MCP tools |
| Claude Code | timeline, decisions, activity | MCP tools + commands |

## Authentication

**Option A — You already use Cursor or VS Code with RL4:**

Credentials sync automatically via `~/.rl4/mcp.env`. Run `RL4: Connect` (Cmd+Shift+P) in your IDE. No extra setup needed.

**Option B — Claude Code standalone:**

Go to [rl4.ai/start](https://rl4.ai/start), sign in with GitHub, and follow the Claude Code instructions.

**Option C — Local only (no auth):**

RL4 works locally without authentication. Your `.rl4/` directory is always readable. Cloud features (team sharing, remote workspaces) require auth.

## Team Features

RL4 supports team context sharing:

- **Auto-discovery**: Teammates on the same repo are found automatically
- **Shared workspaces**: Browse a colleague's context (read-only) via `set_workspace`
- **Team onboarding**: `/rl4:onboard` generates a project briefing from real development history

## Requirements

- Node.js >= 18
- Claude Code (latest version)

## Troubleshooting

### MCP server won't start

Re-install dependencies:
```bash
cd ~/.claude/plugins/cache/rl4/mcp-server && npm install
```

### Token expired (401)

If you use Cursor/VS Code: run `RL4: Connect` (Cmd+Shift+P) then reload.

### No evidence found

Run `/rl4:snapshot` to capture your project state. If you already use RL4 in Cursor/VS Code, the evidence is already there.

### Commands not showing up

```bash
rm -rf ~/.claude/plugins/cache
```
Then restart Claude Code and reinstall with `/plugin install rl4@rl4-plugins`.

## Beta Access

Limited lifetime Pro spots for early testers. Sign up at [rl4.ai](https://rl4.ai).

Contact: valentin@rl4.ai

---

*Built by [RL4](https://rl4.ai) — Cross-LLM memory for your codebase.*
