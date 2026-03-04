---
description: Review changes against project history — catch repeated mistakes before push
argument-hint: "Optional: files to review (default: git diff)"
---

# RL4 Review — History-Aware Code Review

You are reviewing code changes against the full project history. RL4 knows every past bug, every reverted change, and every AVOID pattern. Your job is to catch mistakes BEFORE they ship.

## Phase 1: Detect Changed Files

If `$ARGUMENTS` specifies files, use those. Otherwise, detect modified files:
- Run `!git diff --name-only` to get unstaged changes
- Run `!git diff --cached --name-only` to get staged changes
- Combine both lists (deduplicated)

If no changes found, tell the user and stop.

## Phase 2: Gather History Per File

For each changed file, run in parallel:

1. Call `suggest_edit(file, "review")` to get AVOID patterns and lessons for this file.

2. Call `audit_refactor([all_changed_files])` to check for violations across all files at once.

3. Call `search_chats("bug in <file>")` for files that have a history of bugs.

## Phase 3: Validate

Call `rl4_guardrail(summary, "response")` to verify your review is well-cited.

## Phase 4: Present Review

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 REVIEW — History-Aware Code Review                             ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  Files reviewed: {N} (from {git diff | user input})                 ║
 ║                                                                      ║
 ║  ┌─────────────────────────┬──────┬──────────────────────────────┐  ║
 ║  │ File                    │ Stat │ Finding                      │  ║
 ║  ├─────────────────────────┼──────┼──────────────────────────────┤  ║
 ║  │ {file}                  │ {st} │ {finding or "No violations"} │  ║
 ║  └─────────────────────────┴──────┴──────────────────────────────┘  ║
 ║                                                                      ║
 ║  VERDICT: {N} BLOCK, {N} WARN — {recommendation}                   ║
 ║                                                                      ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Status Codes

- `✓ OK` — No violations found
- `⚠ WN` — Warning: WARN-severity pattern matched
- `✖ BL` — Blocker: BLOCK-severity pattern matched (must fix before push)

## Verdict Rules

- **0 BLOCK, 0 WARN** → "All clear — safe to push"
- **0 BLOCK, N WARN** → "Review warnings, then push"
- **N BLOCK** → "Fix blockers before pushing"

## Rules

- Review EVERY changed file, not just the ones that look problematic
- Always check against AVOID patterns — these are learned from real regressions
- If a file has past bugs, flag it even if current changes look safe
- Be specific: mention line numbers and exact violations
