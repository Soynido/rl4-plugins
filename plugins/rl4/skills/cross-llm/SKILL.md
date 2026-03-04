---
description: Explain cross-LLM context sharing when user mentions Cursor, VS Code, or editor switching
---

# RL4 Cross-LLM Context — Editor Interoperability

## When to activate

This skill activates when the user mentions:
- Cursor, VS Code, or switching between editors
- "Cross-LLM", "cross-editor", "shared context"
- "Can my other editor see this?", "Does Cursor know about this?"
- "Transfer context", "share history"

## What to explain

RL4's `.rl4/` directory is the shared memory layer across all editors:

| Editor | Writes to .rl4/ | Reads from .rl4/ |
|--------|-----------------|-------------------|
| Cursor | snapshots, evidence, chat history | MCP tools |
| VS Code | snapshots, evidence, chat history | MCP tools |
| Claude Code | timeline entries, decisions, activity | MCP tools + direct Read |

## How it works

1. **Every editor writes** to the same `.rl4/` directory in the project root
2. **MCP tools** (get_evidence, search_context, rl4_ask, etc.) read from `.rl4/` regardless of which editor wrote the data
3. **Timeline** is chronological and interleaved — entries from Cursor and Claude Code appear together
4. **Chat history** captures conversations from ALL editors (identified by source field)

## Common questions

- "Will my Cursor history show up here?" → Yes, if a snapshot was run from Cursor
- "Can I search Claude Code chats from Cursor?" → Yes, via `search_chats`
- "Do I need to sync manually?" → No, `.rl4/` is on disk. Any editor can read it instantly.
- "What about cloud sync?" → Authenticated users can access workspaces via Supabase (use `list_workspaces` + `set_workspace`)

## Team sharing

- `list_workspaces()` shows your workspaces + shared + auto-discovered teammates
- `set_workspace("<id>")` lets you browse a colleague's context (read-only)
- Team discovery is automatic: same git remote = same team
