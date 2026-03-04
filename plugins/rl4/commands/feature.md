---
description: Build a feature informed by project history, patterns, and past decisions
argument-hint: description of the feature to build
---

# RL4 Feature — Context-Aware Feature Development

You are helping a developer build a new feature. RL4 knows the project's architecture decisions, existing patterns, and what broke in the past. Use this to build the feature right the first time.

## Input

Feature request: $ARGUMENTS

## Phase 1: Discover Existing Patterns

Run in parallel:

1. Call `rl4_ask("existing patterns for <area>")` to find related code and patterns already in the project.

2. Call `search_context("<area>", source="decisions")` to find past architectural decisions about this area.

3. Call `deep_context(related_files, "new feature: <description>")` to get AVOID patterns, hot scores, and coupling for files that will be touched.

4. Call `get_intent_graph()` to map the full coupling neighborhood.

## Phase 2: Present Feature Blueprint

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 FEATURE — Context-Aware Planning                               ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  FEATURE   "{description}"                                          ║
 ║                                                                      ║
 ║  ── Existing Patterns Found ────────────────────────────────────    ║
 ║  • {pattern description} [source]                                    ║
 ║                                                                      ║
 ║  ── Past Decisions ─────────────────────────────────────────────    ║
 ║  • {date}: {decision} [{tag}, {confidence}%]                        ║
 ║                                                                      ║
 ║  ── Files to Touch (by coupling) ───────────────────────────────    ║
 ║  {file} → {file} → {file} ({coupling type})                        ║
 ║  {file} (hot: {score} — touch with caution)                         ║
 ║                                                                      ║
 ║  ── Implementation Blueprint ───────────────────────────────────    ║
 ║  Phase 1: {description}                                              ║
 ║  Phase 2: {description}                                              ║
 ║  Phase 3: {description}                                              ║
 ║                                                                      ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

Wait for user confirmation before implementing.

## Phase 3: Implementation

Implement the feature following the blueprint. For EVERY file you modify:
1. Call `suggest_edit(file, "feature: <intent>")` BEFORE editing
2. Respect all BLOCK-severity AVOID patterns
3. Follow existing patterns discovered in Phase 1

## Phase 4: Post-Build Audit

After implementation, call `audit_refactor([all_modified_files])` to verify the new code doesn't violate project constraints.

## Rules

- ALWAYS check for existing patterns before writing new code — avoid reinventing what exists
- Respect past architectural decisions unless the user explicitly overrides them
- If the feature touches a hot file (score > 0.8), warn the user
