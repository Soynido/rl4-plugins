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

## Install

```bash
/plugin marketplace add Soynido/rl4-plugins
/plugin install rl4@rl4-plugins
```

## Get Started

### 1. Authenticate

Go to [rl4.ai/start](https://rl4.ai/start), sign in with GitHub, and grab your credentials.

```bash
export RL4_ACCESS_TOKEN="your_token"
export RL4_USER_ID="your_user_id"
```

Add to `~/.zshrc` or `~/.bashrc` for persistence.

### 2. Activate

```
/rl4
```

That's it. RL4 shows you an ASCII dashboard with your project stats and gives you full access to your development memory.

## What You Get

### Persistent Memory
Every chat, decision, file change, and commit — captured automatically and queryable instantly. Ask "What was I working on last week?" and get a cited answer.

### Cross-LLM Context Transfer
Switch from Cursor to Claude Code CLI to VS Code — your context follows. Zero re-setup. The same memory layer works everywhere.

### Proof-Based Answers
Every answer is backed by evidence. No hallucinations, no guesses — just facts from your actual development history, with sources cited.

### Smart Search (RAG)
Search across your entire development history with natural language. "What decisions did we make about auth?" returns relevant results with citations.

### Project Skills & Guardrails
Auto-generated DO/DON'T rules extracted from your real development activity. Your AI learns from your project's history, not generic patterns.

## Available Commands

| Command | What it does |
|---------|-------------|
| `/rl4` | Activate RL4 with ASCII dashboard |
| `rl4_ask("question")` | Get cited answers about your codebase |
| `search_context("query")` | Search all evidence with RAG |
| `get_evidence` | Full evidence pack |
| `get_timeline` | Project history journal |
| `get_decisions` | Decision log with confidence |
| `search_chats("query")` | Search chat history |
| `search_cli("query")` | Search CLI command history |

## Works With

| Editor | Status |
|--------|--------|
| **Cursor** | Full support via [RL4 Extension](https://marketplace.visualstudio.com/items?itemName=rl4.rl4-snapshot-cursor) |
| **VS Code** | Full support via RL4 Extension |
| **Claude Code CLI** | Full support via this plugin |
| **Codex / Gemini** | MCP compatible |

## Requirements

- Node.js >= 18
- Claude Code >= 1.0.0
- RL4 account — [rl4.ai/start](https://rl4.ai/start)

## Beta Access

Limited lifetime Pro spots for early testers. Sign up at [rl4.ai](https://rl4.ai).

Contact: valentin@rl4.ai

---

*Built by [RL4](https://rl4.ai) — Cross-LLM memory for your codebase.*
