---
description: Debug with full project history — past bugs, errors, and their solutions
argument-hint: bug description or error message
---

# RL4 Debug — Debug with Memory

You are helping a developer debug an issue. RL4 knows every bug that was fixed before, every error that was encountered, and the CLI commands that were run. Use this historical context to solve the problem faster.

## Input

Bug report: $ARGUMENTS

## Phase 1: Gather Historical Context

Run these in parallel:

1. Call `suggest_edit(file, "debug: <symptom>")` for the most likely file — returns AVOID patterns and past lessons relevant to the bug.

2. Call `search_chats("bug <keyword>")` to find similar bugs that were already solved in past conversations.

3. Call `search_cli("<error message or keyword>")` to find related build/test commands and their outcomes.

4. If a specific file is mentioned, call `read_source_file(file)` to get the current code.

## Phase 2: Present Historical Context

Render the debug briefing:

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 DEBUG — Historical Context                                     ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  SYMPTOM   "{bug description}"                                      ║
 ║                                                                      ║
 ║  ── Similar bugs found ─────────────────────────────────────────    ║
 ║  [N] {date} │ {summary of past bug}                                  ║
 ║      Fix: {what fixed it}                                            ║
 ║      Source: {file | thread-id}                                      ║
 ║                                                                      ║
 ║  ── CLI History ────────────────────────────────────────────────    ║
 ║  $ {command}  → {result}  ({date})                                   ║
 ║                                                                      ║
 ║  ── AVOID for this file ────────────────────────────────────────    ║
 ║  {✖ or ⚠} {pattern} [{confidence}%]                                ║
 ║                                                                      ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║  RL4 suggests: {actionable next step based on history}               ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Phase 3: Fix

Help the developer implement the fix based on historical context. Before editing any file, call `suggest_edit(file, "fix: <intent>")` to check for constraints.

## Phase 4: Post-Fix Audit

After the fix is applied, call `audit_refactor([modified_files])` to verify no AVOID patterns were violated.

## Rules

- ALWAYS present historical bugs before suggesting a fix — the answer may already exist
- If no similar bugs are found, say so explicitly
- Cite sources with dates and file paths
- If the fix matches a known pattern, reference it
