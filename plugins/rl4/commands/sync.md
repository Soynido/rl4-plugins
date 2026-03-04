---
description: Sync all chat history from Cursor, VS Code, and Claude Code into RL4 evidence
---

# RL4 Sync — Chat History Sync

You are syncing all chat history from every editor into RL4 evidence. This captures conversations that happened outside the current session.

## Important Warning

Before running, display this warning:

```
⚠ NOTE: Claude Code writes chat files on session close.
  For complete capture, quit Claude Code and restart before
  running this command. Current session messages may be missing.
```

## Phase 1: Backfill Chat History

Call `backfill_chat_history()` to perform a full scan of all chat sources:
- Cursor SQLite DB (no limit — captures entire history)
- Claude Code JSONL files (`~/.claude/projects/`)
- VS Code DB (if available)

The tool deduplicates against existing `chat_history.jsonl` and appends only new messages.

## Phase 2: Ingest Git History

Call `ingest_git_history()` to index recent git commits into RL4 evidence.

## Phase 3: Present Summary

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 SYNC — Chat History Sync                                       ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  ⚠ Claude Code sessions are captured on exit.                       ║
 ║    Restart Claude Code before syncing for full capture.              ║
 ║                                                                      ║
 ║  [1/2] Chat history synced       ████████████████████ done          ║
 ║         Sources: Cursor DB, Claude Code JSONL, VS Code DB           ║
 ║         → {N} new messages added ({N} duplicates skipped)           ║
 ║                                                                      ║
 ║  [2/2] Git history ingested      ████████████████████ done          ║
 ║         → {N} commits indexed                                        ║
 ║                                                                      ║
 ╚══════════════════════════════════════════════════════════════════════╝
   Chat history is now up to date across all editors.
```

## Rules

- Always show the Claude Code warning first — users need to know about the session close behavior
- If `backfill_chat_history` reports 0 new messages, that's fine — it means everything is already synced
- If any step fails, report the error but continue with remaining steps
- This command is lightweight — use `/rl4:snapshot` for full evidence rebuild
