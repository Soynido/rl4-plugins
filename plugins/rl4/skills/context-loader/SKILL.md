# RL4 Context Loader

## When to activate
This skill activates automatically when:
- The user asks about project history, past decisions, or "what happened"
- The user references `.rl4/`, evidence, timeline, or snapshots
- The user asks to resume work, continue a task, or pick up where they left off
- The user asks "what was I working on?" or similar context-recovery questions

## What to do

### 1. Bind workspace
Call `set_workspace("current")` to activate the local `.rl4/` directory.

### 2. Load context
Call these MCP tools based on the user's question:

| User intent | Tools to call |
|-------------|---------------|
| "What was I working on?" | `get_timeline` + `get_evidence` |
| "Resume my work" | `get_timeline` (last entry) + `search_context("latest activity")` |
| "What decisions did I make?" | `get_decisions` |
| "Search for X" | `search_context("X")` or `rl4_ask("X")` |
| "What changed in file Y?" | `search_context("Y", source="evidence")` |
| "Show my chat history about Z" | `search_chats("Z")` |
| "What commands did I run?" | `search_cli("query")` |

### 3. Display results with ASCII formatting
Always present results in clean ASCII box format:

```
┌─ CONTEXT LOADED ──────────────────────────────────────────┐
│                                                           │
│  Source: .rl4/timeline.md | Last entry: YYYY-MM-DD        │
│                                                           │
│  {formatted content with citations}                       │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### 4. Citation rules
- ALWAYS cite sources: `[.rl4/timeline.md]`, `[.rl4/evidence.md L42]`, `[YYYY-MM-DD]`
- NEVER fabricate data — if evidence is missing, say "No evidence found for X"
- Use `rl4_guardrail(response, "response")` to validate citations if unsure

### 5. Cross-LLM awareness
The `.rl4/` directory is shared across all editors. When loading context:
- Data may have been written by Cursor, VS Code, or another Claude Code session
- Timeline entries from different editors are interleaved chronologically
- Chat history includes threads from ALL editors (identified by source field)

### 6. Fallback
If MCP tools fail (401, timeout, error):
1. Read `.rl4/evidence.md` directly with the Read tool
2. Read `.rl4/timeline.md` directly with the Read tool
3. Inform user: "Using local files (MCP unavailable). Run /rl4 to reconnect."
