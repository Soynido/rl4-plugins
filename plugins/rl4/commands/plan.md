---
description: Plan any task with full project context — decisions, AVOID patterns, coupling, and history
argument-hint: what you want to plan (e.g., "migrate auth to OAuth2", "split the monolith")
---

# RL4 Plan — Context-Aware Implementation Planning

You are helping a developer plan a significant task. Unlike `/rl4:feature` (which builds and audits), this command focuses on **research and strategy** — gathering all project context to create the best possible plan before writing any code.

## Input

Planning objective: $ARGUMENTS

## Phase 1: Deep Research

Run ALL of these in parallel to gather maximum context:

1. Call `rl4_ask("existing patterns for <area>")` to find how similar things were done before.

2. Call `search_context("<area>", source="decisions")` to find past architectural decisions.

3. Call `deep_context(related_files, "plan: <description>")` to get:
   - AVOID patterns (what NOT to do)
   - Hot scores (which files are dangerous to touch)
   - Coupling maps (which files must change together)
   - Past lessons from edits on these files

4. Call `get_intent_graph()` to get the full dependency graph.

5. Call `search_chats("<area>")` to find past conversations about this topic — what was discussed, attempted, or abandoned.

## Phase 2: Synthesize & Present

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 PLAN — Context-Aware Implementation Plan                       ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  OBJECTIVE   "{description}"                                        ║
 ║                                                                      ║
 ║  ── Past Decisions (relevant) ──────────────────────────────────    ║
 ║  • {date}: {decision} [{tag}, {confidence}%]                        ║
 ║                                                                      ║
 ║  ── AVOID Patterns ─────────────────────────────────────────────    ║
 ║  {✖ or ⚠} {pattern} [{confidence}%]                                ║
 ║                                                                      ║
 ║  ── Coupling Map ───────────────────────────────────────────────    ║
 ║  {file} → {file} → {file} ({coupling type})                        ║
 ║  {N} call sites for {function} across {N} files                     ║
 ║                                                                      ║
 ║  ── Past Discussions ───────────────────────────────────────────    ║
 ║  • {N} threads found about {topic} ({dates})                        ║
 ║  • Key insight: "{quote}" [source]                                  ║
 ║                                                                      ║
 ║  ── Implementation Blueprint ───────────────────────────────────    ║
 ║  Phase 1: {description}                                              ║
 ║  Phase 2: {description}                                              ║
 ║  Phase 3: {description}                                              ║
 ║                                                                      ║
 ║  Risk: {LOW|MEDIUM|HIGH} — {risk summary}                           ║
 ║                                                                      ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║  Use /rl4:refactor or /rl4:feature to execute this plan.            ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Risk Assessment Rules

Calculate risk based on:
- **HIGH**: Any file with hot_score > 0.8, or > 3 past reversals, or > 2 BLOCK patterns
- **MEDIUM**: Files with hot_score 0.4-0.8, or 1-3 WARN patterns
- **LOW**: No hot files, no AVOID patterns, well-isolated changes

## Rules

- This is a RESEARCH command — do NOT write code, only plan
- Surface ALL past discussions about the topic — someone may have already explored this path
- If past attempts were abandoned, explain WHY (this saves the developer from repeating mistakes)
- Always end with concrete next steps and which `/rl4:*` command to use for execution
- Cite every claim with a source
