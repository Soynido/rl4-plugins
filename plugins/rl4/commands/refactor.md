---
description: Safe refactoring — pre-edit briefing from past mistakes, post-edit audit
argument-hint: file(s) to refactor and what you want to change
---

# RL4 Refactor — Safe Refactoring with Memory

You are helping a developer refactor code safely. RL4 knows what broke in the past, what patterns to avoid, and which files are coupled. Use this knowledge to prevent regressions.

## Input

Refactoring request: $ARGUMENTS

## Phase 1: Pre-Edit Briefing

For each file mentioned in the request:

1. Call `deep_context([files], "refactor: <intent>")` to get:
   - Hot score and trajectory (how actively edited this file is)
   - Past reversals (code that was written then reverted)
   - AVOID patterns specific to this file
   - Coupled files (files that are always edited together)

2. Call `get_intent_graph()` to map the coupling neighborhood.

3. For each file, call `suggest_edit(file, "refactor: <intent>")` to get:
   - Lessons from past edits
   - Constraints requiring acknowledgment
   - AVOID patterns with confidence scores

## Phase 2: Present Briefing

Render the pre-edit briefing:

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 REFACTOR — Pre-Edit Briefing                                   ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  TARGET   {file(s)}                                                 ║
 ║  INTENT   {what the user wants to change}                           ║
 ║                                                                      ║
 ║  ── Risk Assessment ────────────────────────────────────────────    ║
 ║  Hot Score    {████████████████████}  {score} ({trajectory})        ║
 ║  Reversals    {N} past reversals on this file                        ║
 ║  Coupled to   [{coupled_file_1}, {coupled_file_2}]                  ║
 ║                                                                      ║
 ║  ── AVOID Patterns (from project history) ──────────────────────    ║
 ║  {✖ BLOCK or ⚠ WARN}  {pattern description} [{confidence}%]       ║
 ║                                                                      ║
 ║  ── Lessons from past edits ────────────────────────────────────    ║
 ║  • {date}: {what happened and what to avoid}                         ║
 ║                                                                      ║
 ║  ── Suggested Approach ─────────────────────────────────────────    ║
 ║  {numbered steps based on lessons learned}                           ║
 ║                                                                      ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║  Proceed with refactoring? (I will audit when you're done)          ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

Wait for user confirmation before proceeding.

## Phase 3: Implementation

After user approves:
- Implement the refactoring following the suggested approach
- Respect ALL BLOCK-severity AVOID patterns — never violate these
- If `suggest_edit` returned `constraints_requiring_ack`, include `contract_ack` when using `apply_edit`

## Phase 4: Post-Edit Audit

After all edits are complete, call `audit_refactor([all_modified_files])`.

Render the audit result:

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 REFACTOR — Post-Edit Audit                                     ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  Files audited: {N}                                                  ║
 ║                                                                      ║
 ║  {file1}    {✓ OK | ⚠ WARN | ✖ BLOCK}    {N} violations            ║
 ║  {file2}    {✓ OK | ⚠ WARN | ✖ BLOCK}    {N} violations            ║
 ║                                                                      ║
 ║  Overall: {SAFE | WARN | BLOCK} — {summary}                         ║
 ║                                                                      ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Phase 5: Rollback (if needed)

If audit finds BLOCK violations:
1. Offer to rollback using `restore_version` (RL4 backed up the files before editing)
2. Use `get_content_store_index()` to find the pre-edit checksum
3. Call `restore_version(file, checksum)` to restore
