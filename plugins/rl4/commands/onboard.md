---
description: Generate a project briefing for new team members from real development history
argument-hint: "Optional: focus area (e.g., \"auth system\", \"deployment\")"
---

# RL4 Onboard — Project Briefing from Real History

You are generating a project briefing for a new team member. Unlike a README (which is often outdated), this briefing is built from REAL development history — what actually happened, what broke, what was decided, and why.

## Phase 1: Gather Full Project Context

Run ALL in parallel:

1. Call `get_evidence()` to get project-level stats (sessions, files, team size, duration).

2. Call `get_timeline()` to get the full project timeline — focus on major milestones.

3. Call `search_context("architecture decisions", source="decisions")` to find key architectural decisions.

4. Call `get_intent_graph()` to identify the most important files (by hot_score and coupling).

5. Call `rl4_ask("key patterns and conventions in this project")` to surface coding patterns.

If `$ARGUMENTS` specifies a focus area, also run:
6. Call `search_context("<focus area>")` and `search_chats("<focus area>")` to go deeper on that topic.

## Phase 2: Present Project Briefing

```
 ╔══════════════════════════════════════════════════════════════════════╗
 ║  RL4 ONBOARD — Project Briefing                                     ║
 ╠══════════════════════════════════════════════════════════════════════╣
 ║                                                                      ║
 ║  PROJECT     {name}                                                 ║
 ║  ACTIVE FOR  {N} days (since {date})                                ║
 ║  TEAM        {N} developer(s) ({names})                             ║
 ║                                                                      ║
 ║  ── Architecture (from decisions) ──────────────────────────────    ║
 ║  • {tech stack and key architectural choices}                        ║
 ║                                                                      ║
 ║  ── Key Decisions ──────────────────────────────────────────────    ║
 ║  • {date}: {decision} [{tag}]                                       ║
 ║                                                                      ║
 ║  ── Watch Out (AVOID patterns) ─────────────────────────────────    ║
 ║  ✖ {pattern} [{confidence}%]                                        ║
 ║                                                                      ║
 ║  ── Hot Files (touch with care) ────────────────────────────────    ║
 ║  {████████████████████}  {file}  {description}                      ║
 ║  {████████████░░░░░░░░}  {file}  {description}                      ║
 ║                                                                      ║
 ║  ── Getting Started ────────────────────────────────────────────    ║
 ║  1. {setup command}                                                  ║
 ║  2. {run/test command}                                               ║
 ║  3. /rl4:ask "{suggested first question}"                           ║
 ║                                                                      ║
 ╚══════════════════════════════════════════════════════════════════════╝
```

## Team Context

If authenticated and team workspaces are available:
- Call `list_workspaces()` to show team members' workspaces
- Mention that the new dev can use `set_workspace("<teammate_id>")` to browse a colleague's context
- Note: multi-workspace requires sequential switching (one at a time via CLI)

## Rules

- Build the briefing from EVIDENCE, not assumptions — cite dates and sources
- Prioritize AVOID patterns — these are the most expensive lessons (learned from real regressions)
- Include "Getting Started" with actual commands that work for this project
- If focused on a specific area, go deep on that area instead of giving a shallow overview
- Always end with a suggested `/rl4:ask` question to show the new dev how to self-serve
