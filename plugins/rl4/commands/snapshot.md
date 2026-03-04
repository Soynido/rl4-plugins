---
description: Capture full project snapshot — evidence, timeline, skills, and git history
---

# RL4 Snapshot — Capture Project State

You are capturing a full project snapshot. This indexes all development activity (chats, files, git commits) and builds the evidence pack that powers all other RL4 commands.

## Phase 1: Run Snapshot

Call `run_snapshot()` to trigger the snapshot pipeline. This works in both IDE and CLI environments — the MCP server auto-detects the environment and uses the appropriate method.

If the snapshot returns an activity summary, use it for the next phases.

## Phase 2: Ingest Git History

If git is available and not yet indexed, call `ingest_git_history()` to capture recent commits.

## Phase 3: Update Timeline & Skills

Using the snapshot results:
1. Append new entries to `.rl4/timeline.md` (ACTIVITY JOURNAL format)
2. Update `.rl4/skills.mdc` with any new AVOID/DO/CONSTRAINTS/INSIGHTS patterns

## Phase 4: Finalize

Call `finalize_snapshot()` to clean up temporary files.

## Phase 5: Present Summary

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 SNAPSHOT — Complete                                            ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  [1/4] Chat sources scanned          ████████████████████ done      ║
 ║  [2/4] Git history ingested          ████████████████████ done      ║
 ║  [3/4] Evidence pack built           ████████████████████ done      ║
 ║  [4/4] Skills & timeline updated     ████████████████████ done      ║
 ║                                                                      ║
 ║  ── Snapshot Summary ───────────────────────────────────────────    ║
 ║  Sessions captured    {N}                                            ║
 ║  Chat threads         {N}                                            ║
 ║  File events          {N}                                            ║
 ║  New decisions        {N}                                            ║
 ║  Git commits          {N}                                            ║
 ║                                                                      ║
 ║  Timeline updated:  .rl4/timeline.md                                ║
 ║  Skills updated:    .rl4/skills.mdc                                 ║
 ║  Evidence:          .rl4/evidence/ ({N} files)                      ║
 ║                                                                      ║
 ╚══════════════════════════════════════════════════════════════════════╝
   Snapshot saved. Your context is safe across all editors.
```

## Rules

- If any step fails, report the error clearly but continue with remaining steps
- If the snapshot result includes a "time saved" metric, include it in the summary
- After snapshot, the `.rl4/` directory is the single source of truth — all editors can read it
