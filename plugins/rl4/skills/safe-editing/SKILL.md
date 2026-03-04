---
description: Automatic safety checks before and after file edits using RL4 CRE
---

# RL4 Safe Editing — Pre/Post Edit Safety

## When to activate

This skill activates automatically before ANY file edit when RL4 is active. It ensures the developer doesn't repeat past mistakes.

## Before editing a file

1. Call `suggest_edit(file_path, intent)` where intent describes what you plan to change.
2. Review the response for:
   - **AVOID patterns** — BLOCK severity means DO NOT proceed without acknowledging
   - **Lessons** — past edits on this file that caused problems
   - **Constraints** — rules that must be followed (include `contract_ack` in `apply_edit` if required)
3. If `suggest_edit` returns BLOCK patterns, warn the user before proceeding.

## After editing a file

1. Call `audit_refactor([modified_files])` to check for violations.
2. If violations are found:
   - **BLOCK**: Stop and inform the user — the edit may reintroduce a known bug
   - **WARN**: Inform the user but allow proceeding
   - **OK**: No action needed

## Rollback

If an edit goes wrong and the user wants to undo:
1. Call `get_content_store_index()` to find the pre-edit version
2. Call `restore_version(file, checksum)` to restore

## Rules

- NEVER skip `suggest_edit` before a significant file change
- ALWAYS respect BLOCK-severity AVOID patterns
- This skill is passive — it enhances other commands, not a standalone workflow
