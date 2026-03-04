---
description: Create an RL4-enriched git commit — audits changes, generates context-aware message, indexes into evidence
argument-hint: "Optional: commit message hint or scope (e.g., \"auth refactor\")"
---

# RL4 Commit — Context-Aware Git Commit

You are creating a git commit enriched with RL4 context. Unlike a regular commit, this audits staged changes against project history, generates a semantically rich commit message, and indexes the result back into RL4 evidence.

## Input

User hint (optional): $ARGUMENTS

## Phase 1: Analyze Staged Changes

Run `git diff --staged --stat` and `git diff --staged` to:
1. List all staged files
2. Count insertions/deletions
3. Understand what changed

If nothing is staged, tell the user to stage files first (`git add`) and stop.

## Phase 2: RL4 Deep Context

Call `deep_context(staged_files, "commit: <summary of changes>")` to get:
- **Hot scores** — which staged files are high-risk
- **AVOID patterns** — what NOT to do with these files
- **Coupling map** — are there coupled files that should also be staged?
- **Past lessons** — history of edits on these files

If coupled files are NOT staged, warn the user:
```
⚠ Coupled files detected but not staged:
  {file} → usually changes with {staged_file}
  Consider: git add {file}
```

## Phase 3: Audit AVOID Patterns

Call `audit_refactor(staged_files)` to verify the staged changes don't violate any known AVOID patterns.

- If violations are found, display them clearly and ask the user whether to proceed or fix first
- If no violations, confirm with a green checkmark

## Phase 4: Generate Commit Message

Using the diff + deep_context + audit results, generate a commit message:

1. **Type**: Determine the conventional commit type (feat/fix/refactor/docs/chore/test/perf)
2. **Scope**: Infer from the files changed (e.g., auth, ui, api)
3. **Subject**: One-line summary of WHAT changed
4. **Body**: WHY it changed — use RL4 context (past decisions, related discussions)
5. **Footer**: `RL4-Context: {N} files audited, {hot_files}, {avoid_checked}`

If the user provided `$ARGUMENTS`, use it as the subject line or to guide the message.

Present the proposed message and ask user to confirm or edit.

## Phase 5: Execute Commit

Run `git commit -m "<message>"` with the approved message.

## Phase 6: Index Into Evidence

Call `ingest_git_history()` to immediately index the new commit into RL4 evidence (as a "Ghost Prompt" — the commit message becomes retroactive intent).

## Phase 7: Present Summary

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 COMMIT — Context-Aware Git Commit                             ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  [1/4] Staged changes analyzed    ████████████████████ done         ║
 ║         {N} files ({N} insertions, {N} deletions)                   ║
 ║                                                                      ║
 ║  [2/4] RL4 deep context check     ████████████████████ done         ║
 ║         Hot files: {list or "none"}                                  ║
 ║         Coupled files: {✓ all staged | ⚠ missing: {files}}          ║
 ║                                                                      ║
 ║  [3/4] AVOID pattern audit        ████████████████████ done         ║
 ║         {✓ No violations | ⚠ N violations (user acknowledged)}      ║
 ║                                                                      ║
 ║  [4/4] Commit created + indexed   ████████████████████ done         ║
 ║                                                                      ║
 ║  ── {type}({scope}): {subject} ──────────────────────────────       ║
 ║  {sha} by {author}                                                   ║
 ║  → Indexed into RL4 evidence via ingest_git_history()                ║
 ║                                                                      ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Rules

- NEVER commit without user confirmation of the message
- If `audit_refactor` finds BLOCK-level violations, do NOT proceed — ask user to fix first
- If `deep_context` reveals coupled files not staged, warn but don't block
- Always run `ingest_git_history()` after commit — this keeps RL4 evidence in sync
- If `$ARGUMENTS` is provided, use it as guidance but still run the full audit pipeline
